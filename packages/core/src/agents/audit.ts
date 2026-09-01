import type { Database } from "bun:sqlite";
import { isPlainObject } from "../util/validate";
import { ulid } from "../util/ulid";
import { getAgent } from "./identity";
import { rfc3339Millis } from "./time";
import { TOOLS } from "./types";
import type {
  AuditDenial,
  AuditItem,
  AuditRow,
  Principal,
  Tool,
} from "./types";

const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

interface StoredAuditRow {
  audit_id: string;
  agent_id: string;
  tool: string;
  query_shape: string;
  served: string;
  denied: string;
  at: string;
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function shapeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length === 0
      ? ""
      : { len: value.length, sha256: sha256(value) };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { type: "non_finite_number" };
  }
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (
      value.length <= 8 &&
      value.every(
        (entry) => typeof entry === "string" && SHORT_ID.test(entry),
      )
    ) {
      return [...value];
    }
    return value.map(shapeValue);
  }
  if (isPlainObject(value)) {
    const shaped: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      shaped[key] = shapeValue(nested);
    }
    return shaped;
  }
  return { type: typeof value };
}

export function shapeArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    shaped[key] = shapeValue(value);
  }
  return shaped;
}

function assertTool(tool: Tool): void {
  if (!(TOOLS as readonly string[]).includes(tool)) {
    throw new TypeError(`tool: must be one of ${TOOLS.join(" | ")}`);
  }
}

export function checkRate(
  db: Database,
  principal: Principal,
  tool: Tool,
  now: string = new Date().toISOString(),
):
  | { allow: true }
  | { allow: false; reason: "rate_limited"; retry_after_seconds: number } {
  if (principal.kind === "owner") return { allow: true };
  assertTool(tool);
  const nowMillis = rfc3339Millis(now, "now");
  const lowerBound = new Date(nowMillis - 60_000).toISOString();
  const upperBound = new Date(nowMillis).toISOString();
  const rows = db
    .query<{ at: string }, [string, string, string]>(
      `SELECT at FROM agent_audit
        WHERE agent_id = ? AND at > ? AND at <= ?
        ORDER BY at, audit_id`,
    )
    .all(principal.agent.agent_id, lowerBound, upperBound);
  if (rows.length < principal.grant.rate_limit_per_minute) {
    return { allow: true };
  }
  const earliest = rows[0];
  if (earliest === undefined) return { allow: true };
  return {
    allow: false,
    reason: "rate_limited",
    retry_after_seconds: Math.max(
      1,
      Math.ceil((rfc3339Millis(earliest.at, "at") + 60_000 - nowMillis) / 1_000),
    ),
  };
}

export function recordAudit(
  db: Database,
  principal: Principal,
  tool: Tool,
  args: Record<string, unknown>,
  served: AuditItem[],
  denied: AuditDenial[],
): string {
  assertTool(tool);
  const auditId = ulid();
  const agentId = principal.kind === "owner" ? "owner" : principal.agent.agent_id;
  db.query<never, [string, string, string, string, string, string, string]>(
    `INSERT INTO agent_audit
       (audit_id, agent_id, tool, query_shape, served, denied, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    auditId,
    agentId,
    tool,
    JSON.stringify(shapeArguments(args)),
    JSON.stringify(served),
    JSON.stringify(denied),
    new Date().toISOString(),
  );
  return auditId;
}

function parseAudit(row: StoredAuditRow): AuditRow {
  return {
    audit_id: row.audit_id,
    agent_id: row.agent_id,
    tool: row.tool as Tool,
    query_shape: JSON.parse(row.query_shape) as Record<string, unknown>,
    served: JSON.parse(row.served) as AuditItem[],
    denied: JSON.parse(row.denied) as AuditDenial[],
    at: row.at,
  };
}

export function listAudit(
  db: Database,
  name: string,
  opts: { limit?: number; since?: string } = {},
): AuditRow[] {
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new TypeError("limit: must be a non-negative integer");
  }
  const agentId = name === "owner" ? "owner" : getAgent(db, name)?.agent_id;
  if (agentId === undefined || limit === 0) return [];

  const conditions = ["agent_id = ?"];
  const bindings: (string | number)[] = [agentId];
  if (opts.since !== undefined) {
    const since = new Date(rfc3339Millis(opts.since, "since")).toISOString();
    conditions.push("at >= ?");
    bindings.push(since);
  }
  bindings.push(limit);
  return db
    .query<StoredAuditRow, (string | number)[]>(
      `SELECT audit_id, agent_id, tool, query_shape, served, denied, at
         FROM agent_audit
        WHERE ${conditions.join(" AND ")}
        ORDER BY at DESC, audit_id DESC
        LIMIT ?`,
    )
    .all(...bindings)
    .map(parseAudit);
}
