import type { ServeContext } from "../../serving/types";
import { canonicalJson } from "../../util/hash";
import { isRfc3339 } from "../../util/time";
import { compareRfc3339 } from "../../agents/time";
import { dependencyRefs, worldEvidenceCurrent, type WorldDependencies } from "../dependencies";
import { parseWorldRef, parseWorldValid } from "../ops/parse";
import type { WorldFrame, WorldOpData, WorldSnapshotRef, WorldValidQuery } from "../ops/types";
import type { WorldNamespace } from "../references";
import { worldViewProjection } from "../../serving/world-clamp";
import { projectionBytes } from "../views/bytes";
import { viewPartitionOf } from "../views/partitions";
import { fingerprintOf, issueView, lookupView } from "../views/store";

const SNAPSHOT_CACHE_SCHEMA = "kizuki.known-snapshot-cache/v1";
const SNAPSHOT_DOMAIN = "known-snapshot" as const;

export interface KnownSnapshotCutoff {
  readonly at: string;
  readonly sequence: number;
}

export interface KnownSnapshotInput {
  /** The normalized internal semantic handle, never a caller-controlled label. */
  readonly handle: string;
  readonly valid: WorldValidQuery;
  /** Exact retained-history position. It stays inside the cache payload. */
  readonly cutoff: KnownSnapshotCutoff;
  /** Reserve the paired retained-view slot atomically before publishing. */
  readonly reserveView?: boolean;
}

type SnapshotPayload = {
  readonly schema: typeof SNAPSHOT_CACHE_SCHEMA;
  readonly handle: string;
  readonly valid: WorldValidQuery;
  readonly purpose: string;
  readonly cutoff: KnownSnapshotCutoff;
};

function purposeOf(ctx: ServeContext): string {
  return ctx.sourcePurpose ?? "recall";
}

/** Bind a token to the exact subject, valid window, and source-purpose scope. */
function scopeDigest(ctx: ServeContext, handle: string, valid: WorldValidQuery): string {
  return fingerprintOf(Buffer.from(canonicalJson({
    schema: SNAPSHOT_CACHE_SCHEMA,
    handle,
    valid,
    purpose: purposeOf(ctx),
  })));
}

function validCutoff(value: KnownSnapshotCutoff): boolean {
  return isRfc3339(value.at) && Number.isSafeInteger(value.sequence) && value.sequence >= 0;
}

function decodePayload(bytes: Uint8Array): SnapshotPayload | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.schema !== SNAPSHOT_CACHE_SCHEMA || typeof record.handle !== "string" ||
      typeof record.purpose !== "string" || typeof record.cutoff !== "object" || record.cutoff === null ||
      Array.isArray(record.cutoff)
    ) return null;
    const cutoff = record.cutoff as Record<string, unknown>;
    if (typeof cutoff.at !== "string" || typeof cutoff.sequence !== "number" || !validCutoff({ at: cutoff.at, sequence: cutoff.sequence })) return null;
    const valid = parseWorldValid(record.valid);
    if (valid === null) return null;
    return {
      schema: SNAPSHOT_CACHE_SCHEMA,
      handle: record.handle,
      valid,
      purpose: record.purpose,
      cutoff: { at: cutoff.at, sequence: cutoff.sequence },
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** A later read can narrow a saved valid window but can never widen it. */
function validWithin(requested: WorldValidQuery, saved: WorldValidQuery): boolean {
  if (saved.kind === "all") return true;
  if (saved.kind === "unknown_only") return requested.kind === "unknown_only";
  if (saved.kind === "at") return requested.kind === "at" && compareRfc3339(requested.at, "at", saved.at, "at") === 0;
  if (requested.kind === "at")
    return compareRfc3339(saved.from, "from", requested.at, "at") <= 0 &&
      compareRfc3339(requested.at, "at", saved.until, "until") < 0;
  return requested.kind === "overlap" &&
    compareRfc3339(saved.from, "from", requested.from, "from") <= 0 &&
    compareRfc3339(requested.until, "until", saved.until, "until") <= 0;
}

/**
 * Retain one private known-at cutoff under the view cache's per-principal
 * quota, lifetime, erasure dependencies and namespace cascade.  The caller
 * owns temporal authorization; this helper only binds and retains its result.
 */
export function issueKnownSnapshot(
  ctx: ServeContext,
  ns: WorldNamespace,
  input: KnownSnapshotInput,
  dependencies: WorldDependencies,
  now: string = new Date().toISOString(),
): WorldSnapshotRef | null {
  if (input.handle.length === 0 || !validCutoff(input.cutoff)) return null;
  const partition = viewPartitionOf(ctx.db, ns.principalId);
  if (partition === null) return null;
  const payload: SnapshotPayload = {
    schema: SNAPSHOT_CACHE_SCHEMA,
    handle: input.handle,
    valid: input.valid,
    purpose: purposeOf(ctx),
    cutoff: input.cutoff,
  };
  try {
    const issued = ctx.db.transaction(() => issueView(
      ctx.db,
      partition,
      ns,
      scopeDigest(ctx, input.handle, input.valid),
      Buffer.from(canonicalJson(payload)),
      dependencyRefs(ctx.db, ns, dependencies),
      now,
      SNAPSHOT_DOMAIN,
      input.reserveView ?? false,
    ))();
    return issued === null ? null : { kind: "snapshot", token: issued.token };
  } catch (error) {
    if (error instanceof Error && error.name === "SQLiteError") return null;
    throw error;
  }
}

/**
 * Resolve exactly the scope that was issued.  Unknown, expired, wrong-domain,
 * erased, policy-invalid, principal-invalid and namespace-invalid inputs all
 * reduce to the same null outcome.
 */
export function lookupKnownSnapshot(
  ctx: ServeContext,
  ns: WorldNamespace,
  ref: WorldSnapshotRef,
  handle: string,
  valid: WorldValidQuery,
  now: string = new Date().toISOString(),
): KnownSnapshotCutoff | null {
  const partition = viewPartitionOf(ctx.db, ns.principalId);
  if (partition === null) return null;
  const stored = lookupView(
    ctx,
    partition,
    ns.id,
    null,
    ref.token,
    now,
    SNAPSHOT_DOMAIN,
  );
  const payload = stored === null ? null : decodePayload(stored.projection);
  if (
    payload === null || payload.handle !== handle || payload.purpose !== purposeOf(ctx) ||
    !validWithin(valid, payload.valid)
  ) return null;
  return payload.cutoff;
}

/**
 * Reuse a prior cutoff only when the complete fresh, redacted projection agrees
 * byte for byte. Do this before issuance so unchanged reads neither consume a
 * quota slot nor evict the baseline. Hidden writes may advance the private
 * clock; clock equality is deliberately not an observable reuse condition.
 */
export function reuseKnownSnapshot(
  frame: WorldFrame,
  handle: string,
  valid: WorldValidQuery,
  operation: string,
  body: (ref: WorldSnapshotRef) => WorldOpData,
): { readonly ref: WorldSnapshotRef; readonly cutoff: KnownSnapshotCutoff } | null {
  const baseline = frame.view?.baseline;
  if (baseline === undefined || baseline === null || frame.dependencies === undefined) return null;
  let retained: unknown;
  try { retained = JSON.parse(Buffer.from(baseline.projection).toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  if (typeof retained !== "object" || retained === null || Array.isArray(retained)) return null;
  const projection = retained as Record<string, unknown>;
  if (projection.operation !== operation || typeof projection.data !== "object" || projection.data === null || Array.isArray(projection.data)) return null;
  const data = projection.data as Record<string, unknown>;
  const knownAt = data.knownAt;
  const candidate = operation === "history" ? data.snapshot
    : typeof knownAt === "object" && knownAt !== null && "kind" in knownAt && knownAt.kind === "snapshot" && "ref" in knownAt ? knownAt.ref : null;
  const ref = parseWorldRef(candidate, "snapshot");
  if (ref === null) return null;
  const cutoff = lookupKnownSnapshot(frame.ctx, frame.ns, ref, handle, valid);
  if (cutoff === null || !worldEvidenceCurrent(frame.ctx, frame.dependencies, cutoff)) return null;
  const bytes = projectionBytes(operation, worldViewProjection(frame.ctx, body(ref)));
  return Buffer.compare(bytes, baseline.projection) === 0 ? { ref, cutoff } : null;
}

/** Recheck the exact returned capability in the final output transaction too. */
export function retainKnownSnapshotDependency(
  frame: WorldFrame, ref: WorldSnapshotRef, handle: string, valid: WorldValidQuery, cutoff: KnownSnapshotCutoff, reuseView = false,
): void {
  if (frame.dependencies === undefined) return;
  frame.dependencies.snapshot = { cutoff, current: ctx => {
    const saved = lookupKnownSnapshot(ctx, frame.ns, ref, handle, valid);
    if (saved === null || saved.at !== cutoff.at || saved.sequence !== cutoff.sequence) return false;
    const view = frame.view;
    return !reuseView || (view !== undefined && view.partition !== null && view.prior !== null &&
      lookupView(ctx, view.partition, frame.ns.id, view.digest, view.prior.token, new Date().toISOString()) !== null);
  } };
}
