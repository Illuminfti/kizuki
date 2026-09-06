import { purgeReadEpoch } from "../derived-holds";
import { sourcePolicyEpoch } from "../ledger/source-grants";
import {
  reserveAudit,
  resolvePrincipal,
  toolAllowed,
  updateAudit,
} from "../agents";
import type {
  AuditDenial,
  AuditItem,
  DenyReason,
  Principal,
  Tool,
} from "../agents";
import type { ClaimsIo } from "../claims/store";
import { claimsEpoch } from "./epoch";
import { compareText } from "../util/order";
import { isPlainObject } from "../util/validate";
import { ServeError, ENVELOPE_SCHEMA } from "./types";
import type {
  CanonChunk,
  Denied,
  Envelope,
  QuotedChunk,
  ServeContext,
} from "./types";

/** Keeps one audit row bounded while the envelope counts stay exact. */
const AUDIT_DENIAL_CAP = 200;

/**
 * A refused call is audited before its arguments are validated, so the bag
 * that reaches the row is whatever the caller sent. These caps keep one row
 * small enough to store and read; the count says how much was dropped.
 */
const AUDIT_KEY_CAP = 32;
const AUDIT_ITEM_CAP = 64;
const AUDIT_DEPTH_CAP = 3;
/** A ceiling on the whole bag, so the three caps above cannot multiply. */
const AUDIT_LEAF_CAP = 192;
/**
 * No tool argument is named this: every input schema is a closed object of
 * fixed keys, so the marker can never be mistaken for something the caller
 * sent. It is a number, which the audit layer records rather than hashes.
 */
const TRUNCATION_KEY = "+truncated";

export interface Served<T> {
  canon: CanonChunk[];
  quoted: QuotedChunk[];
  /** Ids and reasons: audited in full, collapsed to counts for the caller. */
  withheld: AuditDenial[];
  data?: T;
  /** Ids the call created, merged into the audited arguments. */
  audit_ids?: Record<string, string[]>;
  /** Authorized claim metadata actually included in the text projection. */
  audit_served?: AuditItem[];
}

export interface ServeCall {
  /**
   * Authority re-resolved for this call. A tool must read the grant from
   * here, never from the context a long-lived client connected with.
   */
  ctx: ServeContext;
  /** The audit row's instant, so a rendered brief and its row agree. */
  at: string;
}

/**
 * The audited argument bag. Absent optional arguments are dropped rather than
 * recorded as nulls, so an audit row shows what the caller actually asked for.
 */
export function auditArguments(args: object): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) shaped[key] = value;
  }
  return shaped;
}

interface Budget {
  leaves: number;
  dropped: number;
}

function boundedProperty(
  target: object,
  key: string,
  property: PropertyDescriptor,
  depth: number,
  budget: Budget,
): void {
  if ("value" in property) {
    Object.defineProperty(target, key, { value: boundedValue(property.value, depth, budget), enumerable: true, configurable: true });
  } else if (budget.leaves <= 0 || depth > AUDIT_DEPTH_CAP) {
    budget.dropped += 1;
    Object.defineProperty(target, key, { value: null, enumerable: true, configurable: true });
  } else {
    budget.leaves -= 1;
    // The shared audit shaper reads descriptors and emits an accessor marker.
    // Keeping the descriptor here must never execute captured getter code.
    Object.defineProperty(target, key, { ...property, enumerable: true, configurable: true });
  }
}

function boundedValue(value: unknown, depth: number, budget: Budget): unknown {
  if (budget.leaves <= 0 || depth > AUDIT_DEPTH_CAP) {
    budget.dropped += 1;
    return null;
  }
  if (Array.isArray(value)) {
    budget.dropped += Math.max(0, value.length - AUDIT_ITEM_CAP);
    const shaped: unknown[] = new Array(Math.min(value.length, AUDIT_ITEM_CAP));
    for (let index = 0; index < shaped.length; index += 1) {
      const key = String(index);
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property !== undefined) boundedProperty(shaped, key, property, depth + 1, budget);
    }
    return shaped;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    budget.dropped += Math.max(0, keys.length - AUDIT_KEY_CAP);
    const shaped = Object.create(null) as Record<string, unknown>;
    for (const key of keys.slice(0, AUDIT_KEY_CAP)) {
      if (depth === 0 && key === TRUNCATION_KEY) {
        budget.dropped += 1;
        continue;
      }
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property !== undefined) boundedProperty(shaped, key, property, depth + 1, budget);
    }
    return shaped;
  }
  budget.leaves -= 1;
  return value;
}

/**
 * Bounds the row a caller can grow: key count, array length, nesting, and a
 * ceiling on the whole bag. A dropped value becomes null and the count of
 * them rides on one extra key, so the row stays honest about what is missing.
 */
function boundedArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const budget: Budget = { leaves: AUDIT_LEAF_CAP, dropped: 0 };
  const shaped = boundedValue(args, 0, budget) as Record<string, unknown>;
  if (budget.dropped === 0) return shaped;
  // The shared shaper accepts 32 root entries. Reserve one for omission
  // evidence: integer-index keys enumerate before it regardless of insertion.
  const keys = Object.keys(shaped);
  for (const key of keys.slice(AUDIT_KEY_CAP - 1)) {
    delete shaped[key];
    budget.dropped += 1;
  }
  const result = Object.create(null) as Record<string, unknown>;
  result[TRUNCATION_KEY] = budget.dropped;
  return Object.defineProperties(result, Object.getOwnPropertyDescriptors(shaped));
}

/**
 * The claim store's io, carrying the process's one retrieval connection when
 * the host bound one.
 */
export function claimsIo(ctx: ServeContext): ClaimsIo {
  return {
    db: ctx.db,
    ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
  };
}

export function principalName(principal: Principal): string {
  return principal.kind === "owner" ? principal.name : principal.agent.name;
}

function collapse(withheld: AuditDenial[]): Denied[] {
  const counts = new Map<DenyReason, number>();
  for (const entry of withheld) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => compareText(left.reason, right.reason));
}

function boundedForAudit(withheld: AuditDenial[]): AuditDenial[] {
  if (withheld.length <= AUDIT_DENIAL_CAP) return withheld;
  const remainder = collapse(withheld.slice(AUDIT_DENIAL_CAP));
  return [
    ...withheld.slice(0, AUDIT_DENIAL_CAP),
    ...remainder.map(({ reason, count }) => ({ id: `more:${count}`, reason })),
  ];
}

/**
 * Authority is read from the store on every call, never taken from the
 * context a client connected with. A stdio session outlives the grant it
 * started with, so revocation and a narrowed grant have to reach a live
 * connection without waiting for a restart.
 */
function liveContext(ctx: ServeContext): ServeContext | null {
  const current = resolvePrincipal(ctx.db, ctx.principal);
  if (current === null) return null;
  return { ...ctx, principal: current };
}

function servedItems(canon: CanonChunk[], quoted: QuotedChunk[]): AuditItem[] {
  return [
    ...canon.map((chunk) => ({
      id: chunk.page_id,
      sensitivity: chunk.sensitivity,
      taint: chunk.taint,
      authority: chunk.authority,
      provenance_count: chunk.sources.length,
    })),
    ...quoted.map((chunk) => ({
      id: chunk.event_id,
      sensitivity: chunk.sensitivity,
      taint: "quoted",
      authority: null,
      provenance_count: 1,
    })),
  ];
}

interface Entered {
  live: ServeContext;
  audit_id: string;
}

/**
 * The single enforcement point below the prompt layer. The rolling count
 * and the row are one reservation — a revoked client's stale limit still
 * bounds it — then the row is marked unknown_agent or tool_not_granted
 * when those apply. Every path out of here leaves that one row behind.
 */
function enter(
  ctx: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  at: string,
): Entered {
  const bag = boundedArguments(args);
  const live = liveContext(ctx);
  const reserved = reserveAudit(
    ctx.db,
    live?.principal ?? ctx.principal,
    tool,
    bag,
    at,
  );
  if (!reserved.allow) {
    throw new ServeError("rate_limited", "rate limited", {
      retry_after_seconds: reserved.retry_after_seconds,
    });
  }
  if (live === null) {
    updateAudit(ctx.db, reserved.audit_id, bag, [], [
      { id: `tool:${tool}`, reason: "unknown_agent" },
    ]);
    throw new ServeError("unknown_agent", "unknown agent");
  }
  if (!toolAllowed(live.principal.grant, tool)) {
    updateAudit(live.db, reserved.audit_id, bag, [], [
      { id: `tool:${tool}`, reason: "tool_not_granted" },
    ]);
    throw new ServeError("tool_not_granted", "tool not granted");
  }
  return { live: { ...live, sourcePurpose: tool === "correct" ? "correction" : tool === "propose" ? "derive" : live.sourcePurpose ?? "recall" }, audit_id: reserved.audit_id };
}

/** Whatever `run` threw becomes an audited refusal with a stable message. */
function failed(
  live: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  auditId: string,
  error: unknown,
): never {
  const bag = boundedArguments(args);
  const record = (reason: DenyReason): void => {
    updateAudit(live.db, auditId, bag, [], [{ id: `tool:${tool}`, reason }]);
  };
  if (error instanceof ServeError) {
    record(error.code);
    throw error;
  }
  if (error instanceof RangeError) {
    record("invalid_arguments");
    throw new ServeError(
      "invalid_arguments",
      "invalid arguments: request out of range",
      { cause: error },
    );
  }
  record("error");
  throw new ServeError("error", "serving failed", { cause: error });
}

function envelopeOf<T>(
  live: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  at: string,
  auditId: string,
  served: Served<T>,
): Envelope<T> {
  updateAudit(
    live.db,
    auditId,
    boundedArguments({ ...args, ...served.audit_ids }),
    [...servedItems(served.canon, served.quoted), ...(served.audit_served ?? [])],
    boundedForAudit(served.withheld),
  );

  const data = served.data;
  return {
    schema: ENVELOPE_SCHEMA,
    tool,
    principal: principalName(live.principal),
    at,
    canon: served.canon,
    quoted: served.quoted,
    denied: collapse(served.withheld),
    ...(sourcePolicyEpoch(live.db) === 0 ? {} : { source_policy: { mode: "enforced" as const, epoch: sourcePolicyEpoch(live.db), legacy_unbound: "owner_only" as const } }),
    ...(data === undefined ? {} : { data }),
  };
}

export function gate<T>(
  ctx: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  run: (call: ServeCall) => Served<T>,
): Envelope<T> {
  const at = new Date().toISOString();
  const { live, audit_id } = enter(ctx, tool, args, at);
  const sourceEpoch = sourcePolicyEpoch(live.db);
  const purgeEpoch = purgeReadEpoch(live.db);
  let served: Served<T>;
  try {
    served = run({ ctx: live, at });
    if (purgeReadEpoch(live.db) !== purgeEpoch) throw new ServeError("held", "canon unavailable during purge recovery");
    if (sourcePolicyEpoch(live.db) !== sourceEpoch) throw new ServeError("error", "source authorization changed during serving");
  } catch (error) {
    failed(live, tool, args, audit_id, error);
  }
  return envelopeOf(live, tool, args, at, audit_id, served);
}

/**
 * The same gate for a tool whose work is asynchronous. The claim store is
 * async because a retrieval port may be bound to it, so the two write tools
 * come through here; nothing else about the order changes.
 */
export async function gateAsync<T>(
  ctx: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  run: (call: ServeCall) => Promise<Served<T>>,
): Promise<Envelope<T>> {
  const at = new Date().toISOString();
  const { live, audit_id } = enter(ctx, tool, args, at);
  const sourceEpoch = sourcePolicyEpoch(live.db);
  const purgeEpoch = purgeReadEpoch(live.db);
  const readEpoch = tool === "search" || tool === "context_packet" ? claimsEpoch(live.db) : null;
  let served: Served<T>;
  try {
    served = await run({ ctx: live, at });
    if (purgeReadEpoch(live.db) !== purgeEpoch) throw new ServeError("held", "canon unavailable during purge recovery");
    if (sourceEpoch !== sourcePolicyEpoch(live.db)) throw new ServeError("error", "source authorization changed during request; retry");
    // Async reads may overlap grant changes. Refuse the entire result rather
    // than returning a packet assembled under withdrawn authority.
    if (readEpoch !== null && readEpoch !== claimsEpoch(live.db)) {
      throw new ServeError("error", "memory changed during request; retry");
    }
    const current = liveContext(ctx);
    if (current === null) throw new ServeError("unknown_agent", "unknown agent");
    if (live.principal.kind === "agent" && current.principal.kind === "agent" &&
        live.principal.grant_epoch !== current.principal.grant_epoch) {
      throw new ServeError("error", "authority changed during request; retry");
    }
  } catch (error) {
    failed(live, tool, args, audit_id, error);
  }
  return envelopeOf(live, tool, args, at, audit_id, served);
}
