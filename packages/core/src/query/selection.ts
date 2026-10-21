import type { Database } from "bun:sqlite";
import { rawRef, rawSubjectNamespace, type RawSubjectRef } from "../contracts/claim-v2";

/** Resolved request filters, never authority. Public callers provide wire refs;
 * only Core fills this structure after current-namespace resolution. */
export interface EvidenceSelection {
  readonly claimIds?: readonly string[];
  readonly subjects?: readonly RawSubjectRef[];
  readonly source?: { readonly sourceKey: string | null; readonly captureEventId: string | null };
}
export function rawSubjectMembership(raw: RawSubjectRef): { sql: string; bindings: string[] } | null {
  if (!rawRef(raw)) return null;
  if (raw.kind === "occurrence") return {
    sql: `EXISTS(SELECT 1 FROM claim_occurrences o WHERE o.occurrence_id=? AND o.event_id=events.event_id
      AND o.content_hash_version=events.content_hash_version AND o.event_content_hash=events.content_hash
      AND o.text_hash=events.text_hash AND o.origin_binding=events.origin_binding AND o.accepted_at=events.accepted_at)`, bindings: [raw.id],
  };
  if (!("namespace" in raw)) return null;
  return { sql: `events.connector_id=? AND EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=events.event_id AND b.source_key=?)
    AND EXISTS(SELECT 1 FROM json_each(events.subjects) s WHERE json_extract(s.value,'$.subject_id')=?)`,
    bindings: [raw.namespace.connector_id, raw.namespace.source_key, raw.id] };
}
export function selectedEventSql(selection: EvidenceSelection | undefined): { sql: string; bindings: string[] } {
  const clauses: string[] = [], bindings: string[] = [];
  if (selection?.subjects !== undefined) {
    const members = selection.subjects.map(rawSubjectMembership);
    clauses.push(members.length === 0 ? "0" : `(${members.map(member => member === null ? "0" : `(${member.sql})`).join(" OR ")})`);
    for (const member of members) if (member !== null) bindings.push(...member.bindings);
  }
  const source = selection?.source;
  if (source !== undefined) {
    clauses.push(source.sourceKey === null ? "events.event_id=?" : "EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=events.event_id AND b.source_key=?)");
    bindings.push(source.sourceKey ?? source.captureEventId ?? "");
  }
  return { sql: clauses.length === 0 ? "1" : clauses.join(" AND "), bindings };
}
export function selectedEvent(db: Database, selection: EvidenceSelection | undefined, eventId: string): boolean {
  if (selection === undefined) return true;
  const where = selectedEventSql(selection);
  return db.query(`SELECT 1 FROM events WHERE event_id=? AND ${where.sql}`).get(eventId, ...where.bindings) !== null;
}
export function selectedPage(db: Database, selection: EvidenceSelection | undefined, ids: readonly string[]): boolean {
  if (selection === undefined) return true;
  const where = selectedEventSql(selection);
  return db.query(`SELECT 1 FROM events WHERE event_id IN (SELECT value FROM json_each(?)) AND ${where.sql} LIMIT 1`).get(JSON.stringify(ids), ...where.bindings) !== null;
}
/** Typed claims match their qualified subject directly. Legacy claims must cite
 * an exact membership as well as carry the selected raw ID. */
export function selectedClaimSql(selection: EvidenceSelection | undefined, alias = "claims"): { sql: string; bindings: string[] } {
  if (selection?.claimIds !== undefined) return { sql: `${alias}.claim_id IN (SELECT value FROM json_each(?))`, bindings: [JSON.stringify(selection.claimIds)] };
  if (selection?.subjects === undefined) return { sql: "1", bindings: [] };
  const clauses: string[] = [], bindings: string[] = [];
  for (const raw of selection.subjects) {
    const membership = rawSubjectMembership(raw);
    if (membership === null) continue;
    clauses.push(`((${alias}.is_world_typed=1 AND EXISTS(SELECT 1 FROM claim_v2_semantics cs WHERE cs.claim_id=${alias}.claim_id AND cs.subject_kind=? AND cs.subject_id=? AND coalesce(json_extract(cs.payload,'$.subject.namespace'),'')=?))
      OR (${alias}.is_world_typed=0 AND (${alias}.subject=? OR EXISTS(SELECT 1 FROM json_each(${alias}.subjects) s WHERE s.value=?))
        AND EXISTS(SELECT 1 FROM events WHERE events.event_id IN (SELECT value FROM json_each(${alias}.provenance)) AND ${membership.sql})))`);
    bindings.push(raw.kind, raw.id, rawSubjectNamespace(raw), raw.id, raw.id, ...membership.bindings);
  }
  return { sql: clauses.length === 0 ? "0" : `(${clauses.join(" OR ")})`, bindings };
}
