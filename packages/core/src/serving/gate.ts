import { checkRate, recordAudit, toolAllowed } from "../agents";
import type {
  AuditDenial,
  AuditItem,
  DenyReason,
  Principal,
  Tool,
} from "../agents";
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

export interface Served<T> {
  canon: CanonChunk[];
  quoted: QuotedChunk[];
  /** Ids and reasons: audited in full, collapsed to counts for the caller. */
  withheld: AuditDenial[];
  data?: T;
  /** Ids the call created, merged into the audited arguments. */
  audit_ids?: Record<string, string[]>;
}

export function principalName(principal: Principal): string {
  return principal.kind === "owner" ? principal.name : principal.agent.name;
}

function compareText(left: string, right: string): number {
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
): void {
  recordAudit(
    ctx.db,
    ctx.principal,
    tool,
    args,
    [],
    [{ id: `tool:${tool}`, reason }],
  );
}

function auditedAt(ctx: ServeContext, auditId: string): string {
  const row = ctx.db
    .query<{ at: string }, [string]>(
      "SELECT at FROM agent_audit WHERE audit_id = ?",
    )
    .get(auditId);
  if (row === null) throw new ServeError("error", "serving failed");
  return row.at;
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
 * The single enforcement point below the prompt layer: tool allowlist, then
 * rate limit, then the grant-filtered read, then the audit row. Every path out
 * of here — served, refused or failed — leaves a row behind.
 */
export function gate<T>(
  ctx: ServeContext,
  tool: Tool,
  args: Record<string, unknown>,
  run: () => Served<T>,
): Envelope<T> {
  if (!toolAllowed(ctx.principal.grant, tool)) {
    auditRefusal(ctx, tool, args, "tool_not_granted");
    throw new ServeError("tool_not_granted", "tool not granted");
  }

  const rate = checkRate(ctx.db, ctx.principal, tool);
  if (!rate.allow) {
    auditRefusal(ctx, tool, args, "rate_limited");
    throw new ServeError("rate_limited", "rate limited", {
      retry_after_seconds: rate.retry_after_seconds,
    });
  }

  let served: Served<T>;
  try {
    served = run();
  } catch (error) {
    if (error instanceof ServeError) {
      auditRefusal(ctx, tool, args, error.code);
      throw error;
    }
    if (error instanceof RangeError) {
      auditRefusal(ctx, tool, args, "invalid_arguments");
      throw new ServeError(
        "invalid_arguments",
        "invalid arguments: request out of range",
        { cause: error },
      );
    }
    auditRefusal(ctx, tool, args, "error");
    throw new ServeError("error", "serving failed", { cause: error });
  }

  const auditId = recordAudit(
    ctx.db,
    ctx.principal,
    tool,
    { ...args, ...served.audit_ids },
    servedItems(served.canon, served.quoted),
    boundedForAudit(served.withheld),
  );

  const data = served.data;
  return {
    schema: ENVELOPE_SCHEMA,
    tool,
    principal: principalName(ctx.principal),
    at: auditedAt(ctx, auditId),
    canon: served.canon,
    quoted: served.quoted,
    denied: collapse(served.withheld),
    ...(data === undefined ? {} : { data }),
  };
}
