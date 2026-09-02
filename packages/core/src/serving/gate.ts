import {
  checkRate,
  listAgents,
  recordAudit,
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

function boundedValue(value: unknown, depth: number, budget: Budget): unknown {
  if (budget.leaves <= 0 || depth > AUDIT_DEPTH_CAP) {
    budget.dropped += 1;
    return null;
  }
  if (Array.isArray(value)) {
    budget.dropped += Math.max(0, value.length - AUDIT_ITEM_CAP);
    return value
      .slice(0, AUDIT_ITEM_CAP)
      .map((entry) => boundedValue(entry, depth + 1, budget));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    budget.dropped += Math.max(0, entries.length - AUDIT_KEY_CAP);
    const shaped: Record<string, unknown> = {};
    for (const [key, nested] of entries.slice(0, AUDIT_KEY_CAP)) {
      shaped[key] = boundedValue(nested, depth + 1, budget);
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
  return budget.dropped === 0
    ? shaped
    : { ...shaped, [TRUNCATION_KEY]: budget.dropped };
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

function auditRefusal(
  ctx: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  reason: DenyReason,
  at: string,
): void {
  recordAudit(
    ctx.db,
    ctx.principal,
    tool,
    args,
    [],
    [{ id: `tool:${tool}`, reason }],
    at,
  );
}

/**
 * Authority is read from the store on every call, never taken from the
 * context a client connected with. A stdio session outlives the grant it
 * started with, so revocation and a narrowed grant have to reach a live
 * connection without waiting for a restart.
 */
function liveContext(ctx: ServeContext): ServeContext | null {
  if (ctx.principal.kind === "owner") return ctx;
  const agentId = ctx.principal.agent.agent_id;
  const current = listAgents(ctx.db).find((row) => row.agent_id === agentId);
  if (current === undefined || current.revoked_at !== null) return null;
  const { grant, ...agent } = current;
  return { ...ctx, principal: { kind: "agent", agent, grant } };
}

function servedItems(canon: CanonChunk[], quoted: QuotedChunk[]): AuditItem[] {
  return [
    ...canon.map((chunk) => ({
      id: chunk.page_id,
      sensitivity: chunk.sensitivity,
    })),
    ...quoted.map((chunk) => ({
      id: chunk.event_id,
      sensitivity: chunk.sensitivity,
    })),
  ];
}

/** The reserved row a call fills in, or the refusal that took its place. */
type Reservation =
  | { kind: "reserved"; audit_id: string }
  | { kind: "rate_limited"; retry_after_seconds: number };

/**
 * The rolling count and the row it produces are one transaction. Checking the
 * limit and only recording the row after the tool has run leaves a window in
 * which every concurrent call reads the same count and every one of them
 * passes: for the write tools, which await a claim store, that window is the
 * whole call.
 */
function reserve(
  live: ServeContext,
  tool: Tool,
  bag: () => Record<string, unknown>,
  at: string,
): Reservation {
  return live.db.transaction((): Reservation => {
    const rate = checkRate(live.db, live.principal, tool, at);
    if (!rate.allow) {
      recordAudit(
        live.db,
        live.principal,
        tool,
        bag(),
        [],
        [{ id: `tool:${tool}`, reason: "rate_limited" }],
        at,
      );
      return {
        kind: "rate_limited",
        retry_after_seconds: rate.retry_after_seconds,
      };
    }
    return {
      kind: "reserved",
      audit_id: recordAudit(live.db, live.principal, tool, bag(), [], [], at),
    };
  })();
}

interface Entered {
  live: ServeContext;
  audit_id: string;
}

/**
 * The single enforcement point below the prompt layer: current authority,
 * then tool allowlist, then rate limit. Every path out of here — served,
 * refused or failed — leaves a row behind.
 */
function enter(
  ctx: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  at: string,
): Entered {
  // Only a refusal audits the raw bag; a served call audits it with the ids
  // the call created merged in, so the shaping happens once either way.
  const bag = (): Record<string, unknown> => boundedArguments(args);

  const live = liveContext(ctx);
  // Every refusal writes a row, so the limit is checked before the refusal
  // is decided. The grant a revoked client connected with is stale, but a
  // stale limit still bounds it: the alternative is one unmetered row per
  // call from the identity that has just lost its authority.
  if (live === null) {
    const metered = reserve(ctx, tool, bag, at);
    if (metered.kind === "rate_limited") {
      throw new ServeError("rate_limited", "rate limited", {
        retry_after_seconds: metered.retry_after_seconds,
      });
    }
    updateAudit(ctx.db, metered.audit_id, bag(), [], [
      { id: `tool:${tool}`, reason: "unknown_agent" },
    ]);
    throw new ServeError("unknown_agent", "unknown agent");
  }

  if (!toolAllowed(live.principal.grant, tool)) {
    auditRefusal(live, tool, bag(), "tool_not_granted", at);
    throw new ServeError("tool_not_granted", "tool not granted");
  }

  const metered = reserve(live, tool, bag, at);
  if (metered.kind === "rate_limited") {
    throw new ServeError("rate_limited", "rate limited", {
      retry_after_seconds: metered.retry_after_seconds,
    });
  }
  return { live, audit_id: metered.audit_id };
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
    servedItems(served.canon, served.quoted),
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
  let served: Served<T>;
  try {
    served = run({ ctx: live, at });
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
  let served: Served<T>;
  try {
    served = await run({ ctx: live, at });
  } catch (error) {
    failed(live, tool, args, audit_id, error);
  }
  return envelopeOf(live, tool, args, at, audit_id, served);
}
