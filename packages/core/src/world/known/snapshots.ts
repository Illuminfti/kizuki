import type { ServeContext } from "../../serving/types";
import { canonicalJson } from "../../util/hash";
import { isRfc3339 } from "../../util/time";
import { compareRfc3339 } from "../../agents/time";
import { dependencyRefs, type WorldDependencies } from "../dependencies";
import { parseWorldValid } from "../ops/parse";
import type { WorldSnapshotRef, WorldValidQuery } from "../ops/types";
import type { WorldNamespace } from "../references";
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
