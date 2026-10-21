import type { Database } from "bun:sqlite";
import { validateDurableObservation, type DurableObservation } from "../contracts/durable-observation";
import { parseWorldAdmission, completeWorldAnchors } from "../contracts/world-admission";
import { eventFromRow, type EventRow } from "../ledger/event-record";
import { tableExists } from "../ledger/schema";
import { canonicalJson } from "../util/hash";
import { ulid } from "../util/ulid";
import { ClaimError } from "./errors";

/** Called only after the existing writer has checked and inserted the complete
 * support unit, within that writer's transaction. No producer-supplied
 * Observation or attribution is accepted. Backfill uses the same normalizer. */
export function recordSupportObservation(db: Database, supportKey: string): void {
  if (!db.inTransaction) throw new Error("observation normalization requires the support transaction");
  // Old supported schema writers have no observation storage. Schema45 owns
  // installation; reads never create these authority tables.
  if (!tableExists(db, "world_observations")) return;
  if (db.query("SELECT 1 FROM world_observations WHERE support_key=?").get(supportKey) !== null) return;
  const support = db.query<{ admission: string; anchors: string }, [string]>("SELECT admission,anchors FROM claim_v2_support WHERE support_key=?").get(supportKey);
  const history = db.query<{ recorded_at: string; sequence: number }, [string]>("SELECT recorded_at,sequence FROM claim_lifecycle_history WHERE support_key=?").get(supportKey);
  // A pre-known support has no defensible historical position. Do not invent it.
  if (support === null || history === null) return;
  let stored: unknown;
  try { stored = JSON.parse(support.admission); } catch { throw new ClaimError("schema_invalid", "invalid observation admission"); }
  const admission = parseWorldAdmission(stored);
  if (admission === null) return;
  const anchors = completeWorldAnchors(admission.semantic);
  if (anchors.length === 0 || canonicalJson(anchors) !== support.anchors) return;
  const rows = db.query<EventRow, [string]>(`SELECT events.* FROM claim_v2_support_events se JOIN events USING(event_id)
    WHERE se.support_key=? AND se.event_content_hash=events.content_hash ORDER BY events.event_id`).all(supportKey);
  const count = db.query<{ n: number }, [string]>("SELECT count(*) n FROM claim_v2_support_events WHERE support_key=?").get(supportKey)!.n;
  if (rows.length !== count || rows.length === 0 || rows.length > 256) throw new ClaimError("provenance_unresolved", "observation support incomplete");
  // Revoked sources cannot be resurrected by an upgrade backfill.
  if (db.query(`SELECT 1 FROM claim_v2_support_events se JOIN source_event_bindings b USING(event_id)
    JOIN source_grants g USING(source_key) WHERE se.support_key=? AND g.status<>'active' LIMIT 1`).get(supportKey) !== null) return;
  const admissionId = ulid(), observationId = ulid();
  const evidence: Record<string, unknown>[] = [], attribution: Record<string, unknown>[] = [];
  const events = rows.map(row => ({ row, event: eventFromRow(row, db) }));
  for (const { row, event } of events) {
    const binding = db.query<{ source_key: string; grant_revision: number; policy_digest: string }, [string]>("SELECT source_key,grant_revision,policy_digest FROM source_event_bindings WHERE event_id=?").get(event.event_id);
    const common = { admissionId, eventId: event.event_id, eventHashVersion: event.content_hash_version,
      eventHash: event.content_hash, textHash: event.text_hash, originBinding: event.origin_binding, eventAcceptedAt: row.accepted_at,
      sourceBinding: binding === null ? null : { sourceKey: binding.source_key, grantRevision: binding.grant_revision, policyDigest: binding.policy_digest } };
    for (const anchor of anchors.filter(anchor => anchor.event_id === event.event_id)) {
      if (anchor.end_utf16 > event.text.length) throw new ClaimError("provenance_unresolved", "observation span unavailable");
      evidence.push({ ...common, id: ulid(), span: { kind: "text", startUtf16: anchor.start_utf16, endUtf16: anchor.end_utf16 } });
    }
    event.subjects.forEach((subject, index) => {
      const role = subject.role === "from" ? "sender" : subject.role === "to" ? "recipient" : null;
      if (role === null) return;
      const field = `subjects.${index}`, evidenceId = ulid();
      evidence.push({ ...common, id: evidenceId, span: { kind: "metadata", field } });
      attribution.push({ id: ulid(), role, ref: { kind: "supplied", id: subject.subject_id }, basis: "source_field", field, evidenceIds: [evidenceId] });
    });
  }
  // The codec describes one bounded selection. If complete captured attribution
  // cannot fit, keep the original support and report no Observation for it.
  if (evidence.length > 256 || attribution.length > 256) return;
  const times = new Set(events.map(({ event }) => event.occurred_at)), observed = new Set(events.map(({ event }) => event.observed_at));
  const checked = validateDurableObservation({ schema: "kizuki.observation-record/v1", id: observationId, admissionId, evidence, attribution,
    fidelity: "verbatim_text", occurred: times.size === 1 ? { kind: "known", from: events[0]!.event.occurred_at, until: null } : { kind: "unknown" },
    sourceObservedAt: observed.size === 1 ? events[0]!.event.observed_at : null,
    recorded: { admittedAt: history.recorded_at, admissionSeq: history.sequence } });
  if (!checked.ok) throw new ClaimError("schema_invalid", "observation normalization failed");
  db.query("INSERT INTO world_observations(observation_id,admission_id,support_key,record) VALUES (?,?,?,?)").run(observationId, admissionId, supportKey, canonicalJson(checked.value));
  const insert = db.query("INSERT INTO world_observation_events(observation_id,event_id) VALUES (?,?)");
  for (const { event } of events) insert.run(observationId, event.event_id);
}

export function backfillSupportObservations(db: Database): void {
  for (const row of db.query<{ support_key: string }, []>(`SELECT s.support_key FROM claim_v2_support s JOIN claim_lifecycle_history h USING(support_key)
    WHERE NOT EXISTS(SELECT 1 FROM world_observations o WHERE o.support_key=s.support_key) ORDER BY h.sequence`).iterate()) recordSupportObservation(db, row.support_key);
}
export function readDurableObservation(db: Database, observationId: string): { supportKey: string; record: DurableObservation } | null {
  const row = db.query<{ support_key: string; record: string }, [string]>("SELECT support_key,record FROM world_observations WHERE observation_id=? AND length(record)<=262144").get(observationId);
  if (row === null) return null;
  let value: unknown; try { value = JSON.parse(row.record); } catch { return null; }
  const checked = validateDurableObservation(value);
  return checked.ok ? { supportKey: row.support_key, record: checked.value } : null;
}

/** Restore/read integrity: a normalized child cannot invent attribution, a
 * span, a recorded position or a different event version. Missing children
 * remain legal for admissions predating trusted recorded history. */
export function checkedObservation(db: Database, id: string) {
  const found = readDurableObservation(db, id);
  if (found === null || found.record.id !== id) return null;
  const support = db.query<{ admission: string; anchors: string }, [string]>("SELECT admission,anchors FROM claim_v2_support WHERE support_key=?").get(found.supportKey);
  const history = db.query<{ recorded_at: string; sequence: number }, [string]>("SELECT recorded_at,sequence FROM claim_lifecycle_history WHERE support_key=?").get(found.supportKey);
  if (support === null || history === null || found.record.recorded.admittedAt !== history.recorded_at || found.record.recorded.admissionSeq !== history.sequence) return null;
  let parsed: unknown; try { parsed = JSON.parse(support.admission); } catch { return null; }
  const admission = parseWorldAdmission(parsed);
  if (admission === null) return null;
  const anchors = completeWorldAnchors(admission.semantic);
  if (canonicalJson(anchors) !== support.anchors) return null;
  const members = db.query<{ event_id: string }, [string]>("SELECT event_id FROM world_observation_events WHERE observation_id=? ORDER BY event_id").all(id);
  const required = db.query<{ event_id: string }, [string]>("SELECT event_id FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id").all(found.supportKey);
  if (members.length === 0 || members.length > 256 || canonicalJson(members) !== canonicalJson(required)) return null;
  const expectedText = anchors.map(a => canonicalJson([a.event_id, { kind: "text", startUtf16: a.start_utf16, endUtf16: a.end_utf16 }])).sort();
  const actualText = found.record.evidence.filter(e => e.span.kind === "text").map(e => canonicalJson([e.eventId, e.span])).sort();
  if (canonicalJson(expectedText) !== canonicalJson(actualText)) return null;
  const expectedAttribution: string[] = [], expectedMetadata: string[] = [], times = new Set<string>(), observed = new Set<string>();
  for (const member of members) {
    const row = db.query<EventRow, [string]>("SELECT * FROM events WHERE event_id=?").get(member.event_id);
    if (row === null) return null;
    let event; try { event = eventFromRow(row, db); } catch { return null; }
    times.add(event.occurred_at); observed.add(event.observed_at);
    const binding = db.query<{ source_key: string; grant_revision: number; policy_digest: string }, [string]>("SELECT source_key,grant_revision,policy_digest FROM source_event_bindings WHERE event_id=?").get(event.event_id);
    const source = binding === null ? null : { sourceKey: binding.source_key, grantRevision: binding.grant_revision, policyDigest: binding.policy_digest };
    for (const e of found.record.evidence.filter(e => e.eventId === event.event_id)) {
      if (e.eventHashVersion !== event.content_hash_version || e.eventHash !== event.content_hash || e.textHash !== event.text_hash ||
        e.originBinding !== event.origin_binding || e.eventAcceptedAt !== row.accepted_at || canonicalJson(source) !== canonicalJson(e.sourceBinding) ||
        e.span.kind === "text" && e.span.endUtf16 > event.text.length) return null;
    }
    event.subjects.forEach((subject, index) => {
      const role = subject.role === "from" ? "sender" : subject.role === "to" ? "recipient" : null;
      if (role === null) return;
      const field = `subjects.${index}`;
      expectedMetadata.push(canonicalJson([event.event_id, field]));
      expectedAttribution.push(canonicalJson([event.event_id, role, subject.subject_id, field]));
    });
  }
  if (found.record.evidence.some(e => !members.some(m => m.event_id === e.eventId))) return null;
  const actualMetadata = found.record.evidence.flatMap(e => e.span.kind === "metadata" ? [canonicalJson([e.eventId, e.span.field])] : []);
  if (canonicalJson(actualMetadata.sort()) !== canonicalJson(expectedMetadata.sort())) return null;
  const actualAttribution: string[] = [];
  for (const attr of found.record.attribution) {
    if (attr.ref.kind !== "supplied" || attr.evidenceIds.length !== 1) return null;
    const e = found.record.evidence.find(e => e.id === attr.evidenceIds[0]);
    if (e === undefined || e.span.kind !== "metadata" || e.span.field !== attr.field) return null;
    actualAttribution.push(canonicalJson([e.eventId, attr.role, attr.ref.id, attr.field]));
  }
  if (canonicalJson(actualAttribution.sort()) !== canonicalJson(expectedAttribution.sort())) return null;
  const occurred = times.size === 1 ? { kind: "known", from: [...times][0], until: null } : { kind: "unknown" };
  if (found.record.fidelity !== "verbatim_text" || canonicalJson(found.record.occurred) !== canonicalJson(occurred) || found.record.sourceObservedAt !== (observed.size === 1 ? [...observed][0] : null)) return null;
  return { ...found, events: members.map(m => m.event_id) };
}
export function assertObservations(db: Database): void {
  if (!tableExists(db, "world_observations")) return;
  for (const row of db.query<{ observation_id: string }, []>("SELECT observation_id FROM world_observations ORDER BY observation_id").iterate()) {
    if (checkedObservation(db, row.observation_id) === null) throw new ClaimError("provenance_unresolved", "observation does not match its admitted support");
  }
}
