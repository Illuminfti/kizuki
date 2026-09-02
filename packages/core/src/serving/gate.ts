import { checkRate, listAgents, recordAudit, toolAllowed } from "../agents";
import type {
  AuditDenial,
  AuditItem,
  DenyReason,
  Principal,
  Tool,
} from "../agents";
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
 * small enough to store and read; the markers say what was dropped.
 */
const AUDIT_KEY_CAP = 32;
const AUDIT_ITEM_CAP = 64;
const AUDIT_DEPTH_CAP = 3;
/** Refused by the frontmatter key rule, so it can never collide with a real key. */
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

function boundedValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    if (depth === AUDIT_DEPTH_CAP) return `${TRUNCATION_KEY}:depth`;
    const kept = value
      .slice(0, AUDIT_ITEM_CAP)
      .map((entry) => boundedValue(entry, depth + 1));
    if (value.length <= AUDIT_ITEM_CAP) return kept;
    return [...kept, `${TRUNCATION_KEY}:${value.length - AUDIT_ITEM_CAP}`];
  }
  if (isPlainObject(value)) {
    if (depth === AUDIT_DEPTH_CAP) return { [TRUNCATION_KEY]: "depth" };
    const entries = Object.entries(value);
    const shaped: Record<string, unknown> = {};
    for (const [key, nested] of entries.slice(0, AUDIT_KEY_CAP)) {
      shaped[key] = boundedValue(nested, depth + 1);
    }
    if (entries.length > AUDIT_KEY_CAP) {
      shaped[TRUNCATION_KEY] = entries.length - AUDIT_KEY_CAP;
    }
    return shaped;
  }
  return value;
}

/** Bounds the row a caller can grow: key count, array length and nesting. */
function boundedArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return boundedValue(args, 0) as Record<string, unknown>;
}

export function principalName(principal: Principal): string {
  return principal.kind === "owner" ? principal.name : principal.agent.name;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

/**
 * The single enforcement point below the prompt layer: current authority,
 * then tool allowlist, then rate limit, then the grant-filtered read, then
 * the audit row. Every path out of here — served, refused or failed — leaves
 * a row behind.
 */
export function gate<T>(
  ctx: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  run: (call: ServeCall) => Served<T>,
): Envelope<T> {
  const at = new Date().toISOString();
  const bag = boundedArguments(args);

  const live = liveContext(ctx);
  if (live === null) {
    auditRefusal(ctx, tool, bag, "unknown_agent", at);
    throw new ServeError("unknown_agent", "unknown agent");
  }

  if (!toolAllowed(live.principal.grant, tool)) {
    auditRefusal(live, tool, bag, "tool_not_granted", at);
    throw new ServeError("tool_not_granted", "tool not granted");
  }

  const rate = checkRate(live.db, live.principal, tool, at);
  if (!rate.allow) {
    auditRefusal(live, tool, bag, "rate_limited", at);
    throw new ServeError("rate_limited", "rate limited", {
      retry_after_seconds: rate.retry_after_seconds,
    });
  }

  let served: Served<T>;
  try {
    served = run({ ctx: live, at });
  } catch (error) {
    if (error instanceof ServeError) {
      auditRefusal(live, tool, bag, error.code, at);
      throw error;
    }
    if (error instanceof RangeError) {
      auditRefusal(live, tool, bag, "invalid_arguments", at);
      throw new ServeError(
        "invalid_arguments",
        "invalid arguments: request out of range",
        { cause: error },
      );
    }
    auditRefusal(live, tool, bag, "error", at);
    throw new ServeError("error", "serving failed", { cause: error });
  }

  recordAudit(
    live.db,
    live.principal,
    tool,
    boundedArguments({ ...args, ...served.audit_ids }),
    servedItems(served.canon, served.quoted),
    boundedForAudit(served.withheld),
    at,
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
