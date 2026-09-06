import type { Database } from "bun:sqlite";
import { isPlainObject, utf8ByteLength } from "../util/validate";
import { ulid } from "../util/ulid";
import { sha256 } from "./hash";
import { rfc3339Millis } from "./time";
import {
  LIFECYCLE_ACTIONS,
  MAX_AUDIT_ITEMS,
  MAX_AUDIT_PAGE,
  TOOLS,
} from "./types";
import type {
  AuditDenial,
  AuditItem,
  AuditPage,
  AuditRow,
  Grant,
  LifecycleAction,
  Principal,
  Tool,
} from "./types";

const POLICY_DENIAL_ID = /^(?:tool|more):/;
const DANGEROUS_KEY = /^(?:__proto__|constructor|prototype)$/;
const MAX_SHAPE_DEPTH = 8;
const MAX_SHAPE_NODES = 256;
const MAX_OBJECT_KEYS = 32;
const MAX_ARRAY_ITEMS = 32;
const MAX_KEY_CODE_UNITS = 256;
const MAX_STRING_CODE_UNITS = 8 * 1024;
const MAX_HASHED_TEXT_CODE_UNITS = 64 * 1024;
const MAX_QUERY_SHAPE_BYTES = 32 * 1024;

interface StoredAuditRow {
  audit_id: string;
  agent_id: string;
  tool: string;
  query_shape: string;
  served: string;
  denied: string;
  grant_epoch: number | null;
  at: string;
}

function emptyObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

interface ShapeBudget {
  nodes: number;
  hashedTextCodeUnits: number;
}

interface RootShape {
  value: Record<string, unknown>;
  reserved: Set<string>;
}

const NODE_LIMIT = Symbol("audit shape node limit");

// Count every emitted JSON value, including containers and marker fields.
// Reserve four values for the fixed root marker if any construction limit trips.
function chargeNodes(budget: ShapeBudget, count: number): void {
  if (budget.nodes + count > MAX_SHAPE_NODES - 4) throw NODE_LIMIT;
  budget.nodes += count;
}

function marker(budget: ShapeBudget, type: string, reason?: string): Record<string, unknown> {
  chargeNodes(budget, reason === undefined ? 2 : 3);
  const shaped = emptyObject();
  shaped.type = type;
  if (reason !== undefined) shaped.reason = reason;
  return shaped;
}

function rootMarker(type: string, reason?: string): Record<string, unknown> {
  const shaped = emptyObject();
  const detail = emptyObject();
  detail.type = type;
  if (reason !== undefined) detail.reason = reason;
  shaped.__audit_arguments__ = detail;
  return shaped;
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "number" || typeof value === "boolean" || value === "";
}

/** Retain bounded root counters when nested data cannot be represented. */
function truncateRoot(root: RootShape, reason: string): Record<string, unknown> {
  const key = metadataKey("__audit_arguments__", root.reserved);
  const detail = rootMarker("truncated", reason).__audit_arguments__;
  // The original root container and retained scalars were already charged.
  // The temporary root and fixed detail consume the four reserved values.
  let bytes = 2 + utf8ByteLength(JSON.stringify(key)) + 1 + utf8ByteLength(JSON.stringify(detail));
  for (const [field, value] of Object.entries(root.value)) {
    if (!isScalar(value)) {
      delete root.value[field];
      continue;
    }
    const entryBytes = 1 + utf8ByteLength(JSON.stringify(field)) + 1 + utf8ByteLength(JSON.stringify(value));
    if (bytes + entryBytes > MAX_QUERY_SHAPE_BYTES) delete root.value[field];
    else bytes += entryBytes;
  }
  root.value[key] = detail;
  return root.value;
}

function shapeString(value: string, budget: ShapeBudget): unknown {
  if (value.length === 0) {
    chargeNodes(budget, 1);
    return "";
  }
  const available = Math.min(
    MAX_STRING_CODE_UNITS,
    Math.max(0, MAX_HASHED_TEXT_CODE_UNITS - budget.hashedTextCodeUnits),
  );
  if (value.length <= available) {
    chargeNodes(budget, 3);
    budget.hashedTextCodeUnits += value.length;
    return { len: value.length, sha256: sha256(value) };
  }

  const shaped = marker(budget, "string_truncated", "text_limit");
  chargeNodes(budget, available > 0 ? 3 : 1);
  shaped.len = value.length;
  if (available > 0) {
    budget.hashedTextCodeUnits += available;
    shaped.hashed_prefix_len = available;
    shaped.sha256_prefix = sha256(value.slice(0, available));
  }
  return shaped;
}

function metadataKey(preferred: string, reserved: Set<string>): string {
  let candidate = preferred;
  let suffix = 0;
  while (reserved.has(candidate)) {
    candidate = `${preferred}_${++suffix}`;
  }
  reserved.add(candidate);
  return candidate;
}

function shapeKey(
  key: string,
  reserved: Set<string>,
  index: number,
  budget: ShapeBudget,
): { outputKey: string; keyShape?: Record<string, unknown> } {
  if (key.length <= MAX_KEY_CODE_UNITS) return { outputKey: key };
  const keyShape = marker(budget, "key_truncated", "key_length_limit");
  const available = Math.min(
    key.length,
    MAX_STRING_CODE_UNITS,
    Math.max(0, MAX_HASHED_TEXT_CODE_UNITS - budget.hashedTextCodeUnits),
  );
  chargeNodes(budget, available > 0 ? 3 : 1);
  keyShape.len = key.length;
  if (available > 0) {
    budget.hashedTextCodeUnits += available;
    keyShape.hashed_prefix_len = available;
    keyShape.sha256_prefix = sha256(key.slice(0, available));
  }
  return { outputKey: metadataKey(`__audit_truncated_key_${index}__`, reserved), keyShape };
}

function shapeValue(
  value: unknown,
  depth: number,
  budget: ShapeBudget,
  ancestors: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return shapeString(value, budget);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return marker(budget, "non_finite_number");
    chargeNodes(budget, 1);
    return value;
  }
  if (typeof value === "boolean" || value === null) {
    chargeNodes(budget, 1);
    return value;
  }
  if (typeof value !== "object") return marker(budget, typeof value);
  if (depth >= MAX_SHAPE_DEPTH) return marker(budget, "truncated", "depth_limit");
  if (ancestors.has(value)) return marker(budget, "cycle");
  try {
    if (Array.isArray(value)) {
      return shapeArray(value, depth, budget, ancestors);
    }
    if (isPlainObject(value)) {
      return shapeObject(value, depth, budget, ancestors);
    }
  } catch (error) {
    if (error === NODE_LIMIT) throw error;
    return marker(budget, "uninspectable");
  }
  return marker(budget, "object");
}

function shapeArray(
  value: unknown[],
  depth: number,
  budget: ShapeBudget,
  ancestors: WeakSet<object>,
): unknown[] {
  chargeNodes(budget, 1);
  const shaped: unknown[] = [];
  ancestors.add(value);
  try {
    const visibleLength = value.length > MAX_ARRAY_ITEMS
      ? MAX_ARRAY_ITEMS - 1
      : value.length;
    for (let index = 0; index < visibleLength; index += 1) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      if (property === undefined) {
        shaped.push(marker(budget, "hole"));
      } else if (!("value" in property)) {
        shaped.push(marker(budget, "accessor"));
      } else {
        shaped.push(shapeValue(property.value, depth + 1, budget, ancestors));
      }
    }
    if (value.length > MAX_ARRAY_ITEMS) {
      shaped.push(marker(budget, "truncated", "array_limit"));
    }
    return shaped;
  } finally {
    ancestors.delete(value);
  }
}

function shapeObject(
  value: Record<string, unknown>,
  depth: number,
  budget: ShapeBudget,
  ancestors: WeakSet<object>,
  root?: RootShape,
): Record<string, unknown> {
  chargeNodes(budget, 1);
  const shaped = root?.value ?? emptyObject();
  ancestors.add(value);
  try {
    // Reserve every retained caller key before choosing metadata names, so a
    // later caller entry cannot replace an earlier truncation/rejection marker.
    const entries: [string, PropertyDescriptor][] = [];
    let truncated = false;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !property.enumerable) continue;
      if (entries.length >= MAX_OBJECT_KEYS) {
        truncated = true;
        break;
      }
      entries.push([key, property]);
    }
    const reserved = root?.reserved ?? new Set<string>();
    for (const [key] of entries) {
      // Oversized names are never emitted and cannot equal a metadata key.
      if (key.length <= MAX_KEY_CODE_UNITS) reserved.add(key);
    }
    if (root !== undefined) {
      // Structural counters must survive a large nested value, regardless of
      // its insertion order. Inspect only the captured own data descriptors.
      const scalar = (property: PropertyDescriptor): boolean => "value" in property && isScalar(property.value);
      entries.sort((left, right) => Number(scalar(right[1])) - Number(scalar(left[1])));
    }
    for (const [index, [key, property]] of entries.entries()) {
      if (DANGEROUS_KEY.test(key)) {
        chargeNodes(budget, 3);
        const hash = sha256(key);
        shaped[metadataKey(hash, reserved)] = { key: "rejected", sha256: hash };
        continue;
      }
      const keyResult = shapeKey(key, reserved, index + 1, budget);
      const nested = !("value" in property)
        ? marker(budget, "accessor")
        : shapeValue(property.value, depth + 1, budget, ancestors);
      if (keyResult.keyShape !== undefined) chargeNodes(budget, 1);
      shaped[keyResult.outputKey] = keyResult.keyShape === undefined
        ? nested
        : { key: keyResult.keyShape, value: nested };
    }
    if (truncated) {
      shaped[metadataKey("__audit_truncated_entries__", reserved)] = marker(budget, "truncated", "object_key_limit");
    }
    return shaped;
  } finally {
    ancestors.delete(value);
  }
}

export function shapeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const budget = { nodes: 0, hashedTextCodeUnits: 0 };
  const root: RootShape = { value: emptyObject(), reserved: new Set() };
  let shaped: Record<string, unknown>;
  try {
    shaped = isPlainObject(args)
      ? shapeObject(args, 0, budget, new WeakSet<object>(), root)
      : rootMarker("not_plain_object");
  } catch (error) {
    if (error === NODE_LIMIT) return truncateRoot(root, "node_limit");
    return rootMarker("uninspectable");
  }
  return utf8ByteLength(JSON.stringify(shaped)) <= MAX_QUERY_SHAPE_BYTES
    ? shaped
    : truncateRoot(root, "serialized_size_limit");
}

function redactId(id: string): string {
  return POLICY_DENIAL_ID.test(id) ? id : sha256(id);
}

function persistServed(items: AuditItem[]): AuditItem[] {
  return items.map((item) => ({
    id: redactId(item.id),
    sensitivity: item.sensitivity,
    ...(item.taint === undefined ? {} : { taint: item.taint }),
    ...(item.authority === undefined ? {} : { authority: item.authority }),
    ...(item.provenance_count === undefined
      ? {}
      : { provenance_count: item.provenance_count }),
  }));
}

function persistDenied(items: AuditDenial[]): AuditDenial[] {
  return items.map((item) => ({
    id: redactId(item.id),
    reason: item.reason,
  }));
}

function assertCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field}: must be a non-negative safe integer`);
  }
  return Number(value);
}

function assertAuditLists(
  served: AuditItem[],
  denied: AuditDenial[],
): { served: AuditItem[]; denied: AuditDenial[] } {
  if (!Array.isArray(served) || !Array.isArray(denied)) {
    throw new TypeError("served and denied must be arrays");
  }
  if (served.length > MAX_AUDIT_ITEMS || denied.length > MAX_AUDIT_ITEMS) {
    throw new TypeError(`audit items: at most ${MAX_AUDIT_ITEMS} per list`);
  }
  for (const item of served) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.id !== "string" ||
      typeof item.sensitivity !== "string"
    ) {
      throw new TypeError("served: each item needs id and sensitivity");
    }
    if (
      item.provenance_count !== undefined &&
      (!Number.isSafeInteger(item.provenance_count) || item.provenance_count < 0)
    ) {
      throw new TypeError("served: provenance_count must be a non-negative integer");
    }
  }
  for (const item of denied) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.id !== "string" ||
      typeof item.reason !== "string"
    ) {
      throw new TypeError("denied: each item needs id and reason");
    }
  }
  return { served: persistServed(served), denied: persistDenied(denied) };
}

function assertTool(tool: Tool): void {
  if (!(TOOLS as readonly string[]).includes(tool)) {
    throw new TypeError(`tool: must be one of ${TOOLS.join(" | ")}`);
  }
}

function grantEpochOf(principal: Principal): number | null {
  return principal.kind === "agent" ? principal.grant_epoch : null;
}

function insertAudit(
  db: Database,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
  served: AuditItem[],
  denied: AuditDenial[],
  at: string,
  grantEpoch: number | null,
): string {
  const lists = assertAuditLists(served, denied);
  const servedCount = assertCount(lists.served.length, "served_count");
  const deniedCount = assertCount(lists.denied.length, "denied_count");
  const auditId = ulid();
  using statement = db.prepare<
    never,
    [string, string, string, string, string, string, number, number, number | null, string]
  >(
    `INSERT INTO agent_audit
       (audit_id, agent_id, tool, query_shape, served, denied,
        served_count, denied_count, grant_epoch, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  statement.run(
    auditId,
    agentId,
    tool,
    JSON.stringify(shapeArguments(args)),
    JSON.stringify(lists.served),
    JSON.stringify(lists.denied),
    servedCount,
    deniedCount,
    grantEpoch,
    at,
  );
  return auditId;
}

const ACCESS_TOOLS_SQL = TOOLS.map(() => "?").join(", ");

function windowCount(
  db: Database,
  agentId: string,
  lowerBound: string,
  upperBound: string,
): number {
  const row = db
    .query<{ count: number }, (string)[]>(
      `SELECT count(*) AS count FROM agent_audit
        WHERE agent_id = ? AND at > ? AND at <= ?
          AND tool IN (${ACCESS_TOOLS_SQL})`,
    )
    .get(agentId, lowerBound, upperBound, ...TOOLS);
  return row?.count ?? 0;
}

function thresholdAt(
  db: Database,
  agentId: string,
  lowerBound: string,
  upperBound: string,
  offset: number,
): string | null {
  return (
    db
      .query<{ at: string }, (string | number)[]>(
        `SELECT at FROM agent_audit
          WHERE agent_id = ? AND at > ? AND at <= ?
            AND tool IN (${ACCESS_TOOLS_SQL})
          ORDER BY at ASC, audit_id ASC
          LIMIT 1 OFFSET ?`,
      )
      .get(agentId, lowerBound, upperBound, ...TOOLS, offset)?.at ?? null
  );
}

function retryAfterSeconds(
  db: Database,
  agentId: string,
  limit: number,
  count: number,
  nowMillis: number,
  lowerBound: string,
  upperBound: string,
): number {
  const offset = Math.max(0, count - limit);
  const threshold = thresholdAt(db, agentId, lowerBound, upperBound, offset);
  if (threshold === null) return 1;
  return Math.max(
    1,
    Math.ceil((rfc3339Millis(threshold, "at") + 60_000 - nowMillis) / 1_000),
  );
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
  const count = windowCount(db, principal.agent.agent_id, lowerBound, upperBound);
  const limit = principal.grant.rate_limit_per_minute;
  if (count < limit) return { allow: true };
  return {
    allow: false,
    reason: "rate_limited",
    retry_after_seconds: retryAfterSeconds(
      db,
      principal.agent.agent_id,
      limit,
      count,
      nowMillis,
      lowerBound,
      upperBound,
    ),
  };
}

/**
 * The rolling count and the row it produces are one transaction. Checking
 * the limit and inserting later lets concurrent callers share the same
 * remaining slot.
 */
export function reserveAudit(
  db: Database,
  principal: Principal,
  tool: Tool,
  args: Record<string, unknown>,
  at: string = new Date().toISOString(),
):
  | { allow: true; audit_id: string }
  | {
      allow: false;
      reason: "rate_limited";
      retry_after_seconds: number;
      audit_id: string;
    } {
  assertTool(tool);
  const stamped = new Date(rfc3339Millis(at, "at")).toISOString();
  const agentId = principal.kind === "owner" ? "owner" : principal.agent.agent_id;
  return db.transaction(():
    | { allow: true; audit_id: string }
    | {
        allow: false;
        reason: "rate_limited";
        retry_after_seconds: number;
        audit_id: string;
      } => {
    const rate = checkRate(db, principal, tool, stamped);
    if (!rate.allow) {
      const audit_id = insertAudit(
        db,
        agentId,
        tool,
        args,
        [],
        [{ id: `tool:${tool}`, reason: "rate_limited" }],
        stamped,
        grantEpochOf(principal),
      );
      const retry = checkRate(db, principal, tool, stamped);
      if (retry.allow) {
        throw new Error("rate_limited reserve must still be limited after its row");
      }
      return {
        allow: false,
        reason: "rate_limited",
        retry_after_seconds: retry.retry_after_seconds,
        audit_id,
      };
    }
    return {
      allow: true,
      audit_id: insertAudit(
        db,
        agentId,
        tool,
        args,
        [],
        [],
        stamped,
        grantEpochOf(principal),
      ),
    };
  }).immediate();
}

/**
 * `at` is a parameter, like `checkRate`'s `now`, so one served call can stamp
 * its row, its envelope and anything it renders with the same instant. It is
 * normalized on the way in: `checkRate` compares the column as a raw string,
 * so an offset timestamp would leave the rolling window counting nothing.
 */
export function recordAudit(
  db: Database,
  principal: Principal,
  tool: Tool,
  args: Record<string, unknown>,
  served: AuditItem[],
  denied: AuditDenial[],
  at: string = new Date().toISOString(),
): string {
  assertTool(tool);
  const stamped = new Date(rfc3339Millis(at, "at")).toISOString();
  const agentId = principal.kind === "owner" ? "owner" : principal.agent.agent_id;
  return insertAudit(
    db,
    agentId,
    tool,
    args,
    served,
    denied,
    stamped,
    grantEpochOf(principal),
  );
}

export function recordLifecycle(
  db: Database,
  agentId: string,
  action: LifecycleAction,
  change: { before?: Grant; after?: Grant },
  at: string = new Date().toISOString(),
): string {
  if (!(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
    throw new TypeError(`action: must be one of ${LIFECYCLE_ACTIONS.join(" | ")}`);
  }
  const stamped = new Date(rfc3339Millis(at, "at")).toISOString();
  const args = emptyObject();
  args["action"] = action;
  if (change.before !== undefined) {
    args["before"] = JSON.stringify(change.before);
  }
  if (change.after !== undefined) {
    args["after"] = JSON.stringify(change.after);
  }
  return insertAudit(db, agentId, action, args, [], [], stamped, null);
}

/**
 * Fills in a row `reserveAudit` already reserved. The gate writes the row
 * before it runs the tool so the rate count and the row it produces cannot
 * be separated; the outcome is written back here under the same id and the
 * same instant.
 */
export function updateAudit(
  db: Database,
  auditId: string,
  args: Record<string, unknown>,
  served: AuditItem[],
  denied: AuditDenial[],
): void {
  const lists = assertAuditLists(served, denied);
  db.query<never, [string, string, string, number, number, string]>(
    `UPDATE agent_audit
        SET query_shape = ?, served = ?, denied = ?,
            served_count = ?, denied_count = ?
      WHERE audit_id = ?`,
  ).run(
    JSON.stringify(shapeArguments(args)),
    JSON.stringify(lists.served),
    JSON.stringify(lists.denied),
    lists.served.length,
    lists.denied.length,
    auditId,
  );
}

function parseTool(value: string): AuditRow["tool"] {
  if ((TOOLS as readonly string[]).includes(value)) return value as Tool;
  if ((LIFECYCLE_ACTIONS as readonly string[]).includes(value)) {
    return value as LifecycleAction;
  }
  throw new Error("tool: stored value is not a known action");
}

function parseAudit(row: StoredAuditRow): AuditRow {
  const served = JSON.parse(row.served) as unknown;
  const denied = JSON.parse(row.denied) as unknown;
  if (!Array.isArray(served) || !Array.isArray(denied)) {
    throw new Error("audit: stored lists are corrupt");
  }
  const query = JSON.parse(row.query_shape) as unknown;
  return {
    audit_id: row.audit_id,
    agent_id: row.agent_id,
    tool: parseTool(row.tool),
    query_shape: isPlainObject(query) ? query : {},
    served: served as AuditItem[],
    denied: denied as AuditDenial[],
    at: row.at,
    grant_epoch: row.grant_epoch,
  };
}

function decodeCursor(cursor: string): { at: string; audit_id: string } {
  const split = cursor.indexOf("\t");
  if (split <= 0 || split === cursor.length - 1) {
    throw new TypeError("cursor: must be an opaque audit page token");
  }
  const at = cursor.slice(0, split);
  const audit_id = cursor.slice(split + 1);
  rfc3339Millis(at, "cursor");
  if (audit_id.length === 0 || audit_id.length > 64) {
    throw new TypeError("cursor: must be an opaque audit page token");
  }
  return { at, audit_id };
}

export function listAuditPage(
  db: Database,
  name: string,
  opts: {
    limit?: number;
    since?: string;
    cursor?: string;
    kind?: "access" | "lifecycle" | "all";
  } = {},
): AuditPage {
  const requested = opts.limit ?? 50;
  if (!Number.isInteger(requested) || requested < 0) {
    throw new TypeError("limit: must be a non-negative integer");
  }
  const limit = Math.min(requested, MAX_AUDIT_PAGE);
  const agentId =
    name === "owner"
      ? "owner"
      : db
          .query<{ agent_id: string }, [string]>(
            "SELECT agent_id FROM agents WHERE name = ?",
          )
          .get(name)?.agent_id;
  if (agentId === undefined || limit === 0) {
    return { rows: [], next_cursor: null };
  }

  const conditions = ["agent_id = ?"];
  const bindings: (string | number)[] = [agentId];
  if (opts.since !== undefined) {
    conditions.push("at >= ?");
    bindings.push(new Date(rfc3339Millis(opts.since, "since")).toISOString());
  }
  if (opts.cursor !== undefined) {
    const cursor = decodeCursor(opts.cursor);
    conditions.push("(at < ? OR (at = ? AND audit_id < ?))");
    bindings.push(cursor.at, cursor.at, cursor.audit_id);
  }
  const kind = opts.kind ?? "all";
  switch (kind) {
    case "all":
      break;
    case "access":
      conditions.push(`tool IN (${ACCESS_TOOLS_SQL})`);
      bindings.push(...TOOLS);
      break;
    case "lifecycle":
      conditions.push(
        `tool IN (${LIFECYCLE_ACTIONS.map(() => "?").join(", ")})`,
      );
      bindings.push(...LIFECYCLE_ACTIONS);
      break;
    default: {
      const exhaustive: never = kind;
      throw new TypeError(`kind: unknown audit kind ${String(exhaustive)}`);
    }
  }
  bindings.push(limit + 1);
  const fetched = db
    .query<StoredAuditRow, (string | number)[]>(
      `SELECT audit_id, agent_id, tool, query_shape, served, denied,
              grant_epoch, at
         FROM agent_audit
        WHERE ${conditions.join(" AND ")}
        ORDER BY at DESC, audit_id DESC
        LIMIT ?`,
    )
    .all(...bindings)
    .map(parseAudit);
  if (fetched.length <= limit) {
    return { rows: fetched, next_cursor: null };
  }
  const rows = fetched.slice(0, limit);
  const last = rows[rows.length - 1];
  if (last === undefined) return { rows: [], next_cursor: null };
  return { rows, next_cursor: `${last.at}\t${last.audit_id}` };
}

export function listAudit(
  db: Database,
  name: string,
  opts: {
    limit?: number;
    since?: string;
    cursor?: string;
    kind?: "access" | "lifecycle" | "all";
  } = {},
): AuditRow[] {
  return listAuditPage(db, name, opts).rows;
}
