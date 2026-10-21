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
export function issueRawSubjectRef(scope: RefScope, raw: RawSubjectRef): RawSubjectWireRef | null {
  const members = permittedMembership(scope, raw);
  if (members === null || scope.ctx.db.query(`SELECT 1 FROM events WHERE ${members.sql} LIMIT 1`).get(...members.bindings) === null) return null;
  const { ctx, ns } = scope, key = sha256Hex(rawSubjectRefKey(raw));
  let token = ctx.db.query<{ wire_ref: string }, [string, string]>("SELECT wire_ref FROM world_wire_raw_subject_targets WHERE namespace_id=? AND raw_key=?").get(ns.id, key)?.wire_ref;
  if (token === undefined) {
    token = allocateRef(ctx.db, ns, "raw_subject");
    ctx.db.query("INSERT INTO world_wire_raw_subject_targets(namespace_id,wire_ref,raw_key,raw_ref) VALUES (?,?,?,?)").run(ns.id, token, key, canonicalJson(raw));
  }
  // Only permitted exact memberships are materialized. This is one set-based
  // operation; no hidden event text or event list enters the serving process.
  ctx.db.query(`INSERT OR IGNORE INTO world_wire_raw_subject_members(namespace_id,wire_ref,event_id,source_key)
    SELECT ?,?,events.event_id,coalesce((SELECT source_key FROM source_event_bindings b WHERE b.event_id=events.event_id),'')
    FROM events WHERE ${members.sql} ORDER BY events.event_id`).run(ns.id, token, ...members.bindings);
  return ref("raw_subject", token);
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
export function eventRawSubjectRefs(scope: RefScope, eventId: string, ids: readonly string[]): RawSubjectWireRef[] {
  const row = scope.ctx.db.query<{ connector_id: string; source_key: string }, [string]>(`SELECT e.connector_id,b.source_key FROM events e JOIN source_event_bindings b ON b.event_id=e.event_id WHERE e.event_id=?`).get(eventId);
  if (row === null) return [];
  return [...new Set(ids)].flatMap(id => {
    const value = issueRawSubjectRef(scope, { kind: "supplied", id, namespace: row });
    return value === null ? [] : [value];
  });
}
