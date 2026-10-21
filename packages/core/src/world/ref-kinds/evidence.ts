import type { CapturedSubjectRef, ScopedRef } from "../../contracts/scoped-refs";
import { issueWorldRef } from "../references";
import { allocateRef, readableEvent, ref, type RefScope } from "./common";

export function issueEventVersionRef(scope: RefScope, id: string): ScopedRef<"event_version"> | null {
  return readableEvent(scope, id) ? issueWorldRef(scope.ctx.db, scope.ns, "event_version", id) : null;
}
export function resolveEventVersionRef(scope: RefScope, value: ScopedRef): string | null {
  if (value.kind !== "event_version") return null;
  const row = scope.ctx.db.query<{ event_id: string }, [string, string]>(`SELECT e.event_id FROM world_wire_event_version_targets t JOIN events e ON e.event_id=t.event_id
    WHERE t.namespace_id=? AND t.wire_ref=? AND t.content_hash_version=e.content_hash_version
    AND t.content_hash=e.content_hash AND t.text_hash=e.text_hash AND t.origin_binding=e.origin_binding AND t.accepted_at=e.accepted_at`).get(scope.ns.id, value.token);
  return row !== null && readableEvent(scope, row.event_id) ? row.event_id : null;
}
export function issueCapturedSubjectRef(scope: RefScope, eventId: string, subjectId: string): CapturedSubjectRef | null {
  if (!readableEvent(scope, eventId) || scope.ctx.db.query(`SELECT 1 FROM events e,json_each(e.subjects) s WHERE e.event_id=? AND json_extract(s.value,'$.subject_id')=?`).get(eventId, subjectId) === null) return null;
  const existing = scope.ctx.db.query<{ wire_ref: string }, [string, string, string]>("SELECT wire_ref FROM world_wire_captured_subject_targets WHERE namespace_id=? AND event_id=? AND subject_id=?").get(scope.ns.id, eventId, subjectId);
  if (existing !== null) return ref("captured_subject", existing.wire_ref);
  const token = allocateRef(scope.ctx.db, scope.ns, "captured_subject");
  scope.ctx.db.query("INSERT INTO world_wire_captured_subject_targets(namespace_id,wire_ref,event_id,subject_id) VALUES (?,?,?,?)").run(scope.ns.id, token, eventId, subjectId);
  return ref("captured_subject", token);
}
export function resolveCapturedSubjectRef(scope: RefScope, value: ScopedRef): { eventId: string; subjectId: string } | null {
  if (value.kind !== "captured_subject") return null;
  const row = scope.ctx.db.query<{ event_id: string; subject_id: string }, [string, string]>("SELECT event_id,subject_id FROM world_wire_captured_subject_targets WHERE namespace_id=? AND wire_ref=?").get(scope.ns.id, value.token);
  return row !== null && readableEvent(scope, row.event_id) ? { eventId: row.event_id, subjectId: row.subject_id } : null;
}
