import { rawRef, rawSubjectRefKey, type RawSubjectRef } from "../../contracts/claim-v2";
import type { RawSubjectWireRef, ScopedRef } from "../../contracts/scoped-refs";
import { canonicalJson, sha256Hex } from "../../util/hash";
import { authorizedEventSql } from "../policy-sql";
import { allocateRef, ref, type RefScope } from "./common";

import { rawSubjectMembership } from "../../query/selection";
export { rawSubjectMembership } from "../../query/selection";

function permittedMembership(scope: RefScope, raw: RawSubjectRef) {
  const exact = rawSubjectMembership(raw);
  if (exact === null) return null;
  const policy = authorizedEventSql(scope.ctx);
  return { sql: `${exact.sql} AND ${policy.clauses.join(" AND ")}`, bindings: [...exact.bindings, ...policy.bindings] };
}
/**
 * Answers already given inside one reference transaction. A packet or an
 * envelope asks about the same subject for every source event that names it,
 * and each question scans the subject's whole connector. The namespace object
 * lives for one transaction only, so nothing here outlives the call. An answer
 * is reused only for the identical statement and bindings while the connection
 * has written nothing and seen no other commit since it was given; any change
 * in between clears every answer.
 */
const answered = new WeakMap<RefScope["ns"], { stamp: string; byStatement: Map<string, unknown> }>();
function connectionStamp(scope: RefScope): string {
  const row = scope.ctx.db.query<{ changes: number; version: number; schema: number }, []>(
    "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version, (SELECT schema_version FROM pragma_schema_version) AS schema",
  ).get()!;
  return `${row.changes}:${row.version}:${row.schema}`;
}
function inTransactionMemo<T>(scope: RefScope, statement: string, answer: () => T): T {
  if (!scope.ctx.db.inTransaction) return answer();
  let memo = answered.get(scope.ns);
  const before = connectionStamp(scope);
  if (memo === undefined || memo.stamp !== before) answered.set(scope.ns, memo = { stamp: before, byStatement: new Map() });
  if (memo.byStatement.has(statement)) return memo.byStatement.get(statement) as T;
  const value = answer();
  // Issuing writes only this namespace's wire rows, which no membership or
  // policy statement reads, so the answer holds in the state it leaves behind.
  const after = connectionStamp(scope);
  if (after !== memo.stamp) { memo.stamp = after; memo.byStatement.clear(); }
  memo.byStatement.set(statement, value);
  return value;
}
export function issueRawSubjectRef(scope: RefScope, raw: RawSubjectRef): RawSubjectWireRef | null {
  const members = permittedMembership(scope, raw);
  if (members === null) return null;
  const statement = issueStatement(scope, raw, members);
  const token = inTransactionMemo(scope, statement, () => issuePermitted(scope, raw, members)?.token ?? null);
  return token === null ? null : ref("raw_subject", token);
}
/**
 * The text subject IDs that at least one permitted event of this connector and
 * source names: one scan for every subject of the source. An ID outside this
 * set has no permitted membership, which is exactly when issuing it returns null.
 */
function permittedSubjectIds(scope: RefScope, namespace: { connector_id: string; source_key: string }): ReadonlySet<string> {
  const { sql, bindings, statement } = subjectScan(scope, namespace);
  return inTransactionMemo(scope, statement,
    () => new Set(scope.ctx.db.query<{ id: string }, (string | number)[]>(sql).all(...bindings).map(row => row.id)));
}
function subjectScan(scope: RefScope, namespace: { connector_id: string; source_key: string }) {
  const policy = authorizedEventSql(scope.ctx);
  const sql = `SELECT DISTINCT json_extract(subject_item.value,'$.subject_id') AS id FROM events, json_each(events.subjects) subject_item
    WHERE events.connector_id=? AND EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=events.event_id AND b.source_key=?)
    AND typeof(json_extract(subject_item.value,'$.subject_id'))='text' AND ${policy.clauses.join(" AND ")}`;
  const bindings = [namespace.connector_id, namespace.source_key, ...policy.bindings];
  return { sql, bindings, statement: JSON.stringify(["subjects", scope.ns.id, sql, bindings]) };
}
/** The subject set a preparation already read in this state, without reading it. */
function preparedSubjectIds(scope: RefScope, namespace: { connector_id: string; source_key: string }): ReadonlySet<string> | undefined {
  if (!scope.ctx.db.inTransaction) return undefined;
  const memo = answered.get(scope.ns);
  if (memo === undefined || memo.stamp !== connectionStamp(scope)) return undefined;
  return memo.byStatement.get(subjectScan(scope, namespace).statement) as ReadonlySet<string> | undefined;
}
function issuePermitted(scope: RefScope, raw: RawSubjectRef, members: NonNullable<ReturnType<typeof permittedMembership>>): RawSubjectWireRef | null {
  if (scope.ctx.db.query(`SELECT 1 FROM events WHERE ${members.sql} LIMIT 1`).get(...members.bindings) === null) return null;
  const { ctx, ns } = scope, token = subjectTarget(scope, raw);
  // Only permitted exact memberships are materialized. This is one set-based
  // operation; no hidden event text or event list enters the serving process.
  ctx.db.query(`INSERT OR IGNORE INTO world_wire_raw_subject_members(namespace_id,wire_ref,event_id,source_key)
    SELECT ?,?,events.event_id,coalesce((SELECT source_key FROM source_event_bindings b WHERE b.event_id=events.event_id),'')
    FROM events WHERE ${members.sql} ORDER BY events.event_id`).run(ns.id, token, ...members.bindings);
  return ref("raw_subject", token);
}
/** The subject's wire identity in this namespace, allocated on first issue. */
function subjectTarget(scope: RefScope, raw: RawSubjectRef): string {
  const { ctx, ns } = scope, key = sha256Hex(rawSubjectRefKey(raw));
  let token = ctx.db.query<{ wire_ref: string }, [string, string]>("SELECT wire_ref FROM world_wire_raw_subject_targets WHERE namespace_id=? AND raw_key=?").get(ns.id, key)?.wire_ref;
  if (token === undefined) {
    token = allocateRef(ctx.db, ns, "raw_subject");
    ctx.db.query("INSERT INTO world_wire_raw_subject_targets(namespace_id,wire_ref,raw_key,raw_ref) VALUES (?,?,?,?)").run(ns.id, token, key, canonicalJson(raw));
  }
  return token;
}
const issueStatement = (scope: RefScope, raw: RawSubjectRef, members: { sql: string; bindings: unknown[] }): string =>
  JSON.stringify(["issue", scope.ns.id, rawSubjectRefKey(raw), members.sql, members.bindings]);
function eventNamespace(scope: RefScope, eventId: string): { connector_id: string; source_key: string } | null {
  return scope.ctx.db.query<{ connector_id: string; source_key: string }, [string]>(`SELECT e.connector_id,b.source_key FROM events e JOIN source_event_bindings b ON b.event_id=e.event_id WHERE e.event_id=?`).get(eventId);
}
/**
 * Issues, ahead of a projection in the same transaction, every raw subject its
 * chunks will name: one membership scan per connector and source instead of one
 * per subject. Each answer equals what `issueRawSubjectRef` would return, and
 * the rows written are the rows its issues would write. The answers seed the
 * transaction's memo, so the projection's own issues return them while nothing
 * has been written since; after any write they issue as before.
 */
export function prepareEventRawSubjects(scope: RefScope, items: readonly { readonly eventId: string; readonly ids: readonly string[] }[]): void {
  if (!scope.ctx.db.inTransaction) return;
  const groups = new Map<string, { namespace: { connector_id: string; source_key: string }; ids: Set<string> }>();
  const namespaces = new Map<string, { connector_id: string; source_key: string } | null>();
  for (const item of items) {
    if (!namespaces.has(item.eventId)) namespaces.set(item.eventId, eventNamespace(scope, item.eventId));
    const namespace = namespaces.get(item.eventId);
    if (namespace === null || namespace === undefined) continue;
    const key = JSON.stringify([namespace.connector_id, namespace.source_key]);
    const group = groups.get(key) ?? { namespace, ids: new Set<string>() };
    groups.set(key, group);
    for (const id of item.ids) if (plainText(id)) group.ids.add(id);
  }
  // A lone subject costs one membership scan either way; leave it to the ordinary issue.
  for (const { namespace, ids } of groups.values()) if (ids.size > 1) issueSubjectGroup(scope, namespace, [...ids]);
}
function issueSubjectGroup(scope: RefScope, namespace: { connector_id: string; source_key: string }, ids: readonly string[]): void {
  const present = permittedSubjectIds(scope, namespace);
  const memo = answered.get(scope.ns);
  const pending: { raw: RawSubjectRef; statement: string; token?: string }[] = [];
  for (const id of ids) {
    if (!present.has(id)) continue;
    const raw: RawSubjectRef = { kind: "supplied", id, namespace };
    const members = permittedMembership(scope, raw);
    if (members === null) continue;
    const statement = issueStatement(scope, raw, members);
    if (memo?.byStatement.has(statement) !== true) pending.push({ raw, statement });
  }
  if (pending.length < 2) return;
  for (const item of pending) item.token = subjectTarget(scope, item.raw);
  const policy = authorizedEventSql(scope.ctx);
  scope.ctx.db.query(`INSERT OR IGNORE INTO world_wire_raw_subject_members(namespace_id,wire_ref,event_id,source_key)
    SELECT ?,json_extract(wanted.value,'$[0]'),events.event_id,coalesce((SELECT source_key FROM source_event_bindings b WHERE b.event_id=events.event_id),'')
    FROM events CROSS JOIN json_each(events.subjects) subject_item CROSS JOIN json_each(?) wanted
    WHERE events.connector_id=? AND EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=events.event_id AND b.source_key=?)
      AND json_extract(subject_item.value,'$.subject_id')=json_extract(wanted.value,'$[1]') AND ${policy.clauses.join(" AND ")}
    ORDER BY wanted.key, events.event_id`).run(scope.ns.id, JSON.stringify(pending.map(item => [item.token, (item.raw as { id: string }).id])),
    namespace.connector_id, namespace.source_key, ...policy.bindings);
  const stamp = connectionStamp(scope);
  let seeded = answered.get(scope.ns);
  if (seeded === undefined || seeded.stamp !== stamp) answered.set(scope.ns, seeded = { stamp, byStatement: new Map() });
  // The writes above are this namespace's wire rows only, which the subject
  // scan does not read, so its answer holds after them as well.
  seeded.byStatement.set(subjectScan(scope, namespace).statement, present);
  for (const item of pending) seeded.byStatement.set(item.statement, item.token!);
}
export function resolveRawSubjectRef(scope: RefScope, value: ScopedRef): RawSubjectRef | null {
  if (value.kind !== "raw_subject") return null;
  const row = scope.ctx.db.query<{ raw_key: string; raw_ref: string }, [string, string]>("SELECT raw_key,raw_ref FROM world_wire_raw_subject_targets WHERE namespace_id=? AND wire_ref=?").get(scope.ns.id, value.token);
  if (row === null) return null;
  let raw: unknown;
  try { raw = JSON.parse(row.raw_ref); } catch { return null; }
  if (!rawRef(raw) || row.raw_key !== sha256Hex(rawSubjectRefKey(raw))) return null;
  const members = permittedMembership(scope, raw);
  if (members === null || scope.ctx.db.query(`SELECT 1 FROM events WHERE ${members.sql} LIMIT 1`).get(...members.bindings) === null) return null;
  // New independent captures extend custody without changing the wire identity.
  return issueRawSubjectRef(scope, raw) === null ? null : raw;
}
/** Text that binds to SQLite unchanged, so JavaScript equality is SQLite's BINARY equality. */
const plainText = (id: unknown): id is string =>
  typeof id === "string" && !id.includes("\0") && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(id);
export function eventRawSubjectRefs(scope: RefScope, eventId: string, ids: readonly string[]): RawSubjectWireRef[] {
  const row = eventNamespace(scope, eventId);
  if (row === null) return [];
  const unique = [...new Set(ids)];
  const named = preparedSubjectIds(scope, row);
  return unique.flatMap(id => {
    if (named !== undefined && plainText(id) && !named.has(id)) return [];
    const value = issueRawSubjectRef(scope, { kind: "supplied", id, namespace: row });
    return value === null ? [] : [value];
  });
}
