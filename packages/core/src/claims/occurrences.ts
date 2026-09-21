import type { Database } from "bun:sqlite";
import { rawSubjectRefKey, type ClaimV2Assertion, type QualifiedSuppliedRef, type RawSubjectRef } from "../contracts/claim-v2";
import type { TextAnchor } from "../contracts/producer-v2";
import { canonicalJson, sha256Hex } from "../util/hash";
import { utf8ByteLength } from "../util/validate";
import { assertionEndpoints } from "../world/allocation";
import { ClaimError } from "./errors";
import { eventFromRow, type EventRow } from "../ledger/event-record";
import { semanticKey } from "./claim-v2-keys";
import { readClaimV2Semantic } from "./claim-v2-commit";
import { isUlid } from "../util/ulid";

export interface OccurrenceEventIdentity {
  readonly connector_id: string; readonly source_record_id: string; readonly event_id: string;
  readonly content_hash_version: number; readonly content_hash: string; readonly text_hash: string;
  readonly origin_binding: string; readonly accepted_at: string;
}
export interface WorldOccurrenceDraft { readonly anchor: TextAnchor; readonly label: string; }
export interface WorldEndpointProofOptions { readonly restore?: boolean; }
type OccurrenceProof = {
  readonly occurrence_id: string; readonly event_id: string; readonly content_hash_version: number;
  readonly event_content_hash: string; readonly text_hash: string; readonly origin_binding: string;
  readonly accepted_at: string; readonly source_key: string | null; readonly start_utf16: number; readonly end_utf16: number;
};
function tuple(parts: readonly string[]): string {
  const domain = "kizuki.claim/v2#occurrence";
  return sha256Hex(`${utf8ByteLength(domain)}:${domain}${parts.map((part) => `${utf8ByteLength(part)}:${part}`).join("")}`);
}
export function mintOccurrenceId(event: OccurrenceEventIdentity, sourceKey: string | null, anchor: TextAnchor): string {
  return tuple([event.connector_id, sourceKey ?? "native-owner", event.source_record_id, event.event_id,
    String(event.content_hash_version), event.content_hash, event.text_hash, String(anchor.start_utf16), String(anchor.end_utf16)]);
}

function anchors(semantic: ClaimV2Assertion): readonly TextAnchor[] {
  return [...semantic.anchors, ...semantic.perspective.anchors];
}

function qualifiedSupplied(ref: RawSubjectRef): ref is QualifiedSuppliedRef {
  if (typeof ref !== "object" || ref === null || Object.keys(ref).length !== 3 || ref.kind !== "supplied" ||
      !Object.hasOwn(ref, "namespace") || typeof ref.id !== "string" || ref.id.length === 0) return false;
  const namespace = (ref as QualifiedSuppliedRef).namespace;
  return typeof namespace === "object" && namespace !== null && Object.keys(namespace).length === 2 &&
    typeof namespace.connector_id === "string" && namespace.connector_id.length > 0 &&
    typeof namespace.source_key === "string" && isUlid(namespace.source_key);
}

function canonicalOccurrence(ref: RawSubjectRef): boolean {
  return typeof ref === "object" && ref !== null && Object.keys(ref).length === 2 &&
    ref.kind === "occurrence" && typeof ref.id === "string" && /^[a-f0-9]{64}$/.test(ref.id);
}

function sameRef(left: RawSubjectRef, right: RawSubjectRef): boolean {
  return rawSubjectRefKey(left) === rawSubjectRefKey(right);
}

function eventForAnchor(db: Database, anchor: TextAnchor): { readonly row: EventRow; readonly event: ReturnType<typeof eventFromRow> } | null {
  const row = db.query<EventRow, [string]>("SELECT * FROM events WHERE event_id=?").get(anchor.event_id);
  if (row === null) return null;
  try { return { row, event: eventFromRow(row, db) }; } catch { return null; }
}

function hasSubject(event: ReturnType<typeof eventFromRow>, id: string): boolean {
  return event.subjects.some(subject => subject.subject_id === id);
}

function nativeTarget(event: ReturnType<typeof eventFromRow>): { readonly claim_id: string; readonly semantic_key: string; readonly subject: RawSubjectRef; readonly predicate: string } | null {
  const target = event.metadata.world_target;
  if (typeof target !== "object" || target === null || Array.isArray(target) || Object.keys(target).length !== 4) return null;
  const value = target as { claim_id?: unknown; semantic_key?: unknown; subject?: unknown; predicate?: unknown };
  if (typeof value.claim_id !== "string" || !isUlid(value.claim_id) || typeof value.semantic_key !== "string" || !/^[a-f0-9]{64}$/.test(value.semantic_key) || typeof value.predicate !== "string" ||
      typeof value.subject !== "object" || value.subject === null) return null;
  const subject = value.subject as RawSubjectRef;
  return qualifiedSupplied(subject) || canonicalOccurrence(subject)
    ? { claim_id: value.claim_id, semantic_key: value.semantic_key, subject, predicate: value.predicate } : null;
}

function isNativeCorrection(db: Database, event: ReturnType<typeof eventFromRow>): boolean {
  return event.connector_id === "kizuki.owner" && event.origin_binding_kind === "native" &&
    db.query("SELECT 1 FROM native_owner_evidence WHERE event_id=? AND origin='correction'").get(event.event_id) !== null &&
    db.query("SELECT 1 FROM source_event_bindings WHERE event_id=?").get(event.event_id) === null;
}

/** Validates world endpoint provenance without mutating the ledger. */
export function validateWorldEndpointProofs(
  db: Database,
  semantic: ClaimV2Assertion,
  sourceKey: string | null,
  options: WorldEndpointProofOptions = {},
): readonly OccurrenceProof[] {
  const cited = anchors(semantic).flatMap(anchor => {
    const stored = eventForAnchor(db, anchor);
    return stored === null ? [] : [{ anchor, ...stored }];
  });
  if (cited.length !== anchors(semantic).length) throw new ClaimError("provenance_unresolved", "world endpoint cites an invalid event");
  if (sourceKey === null) {
    const target = cited.map(({ event }) => isNativeCorrection(db, event) ? nativeTarget(event) : null).find((value): value is NonNullable<typeof value> => value !== null);
    if (target === undefined || canonicalJson(semantic.subject) !== canonicalJson(target.subject) || semantic.predicate !== target.predicate ||
        !cited.some(({ event }) => isNativeCorrection(db, event) && hasSubject(event, target.subject.id)) ||
        assertionEndpoints(semantic).some(ref => canonicalJson(ref) !== canonicalJson(target.subject))) {
      throw new ClaimError("provenance_unresolved", "native world endpoint lacks its immutable correction target");
    }
    if (!options.restore) {
      const prior = db.query<{ status: string }, [string]>("SELECT status FROM claims WHERE claim_id=?").get(target.claim_id);
      const priorSemantic = prior?.status === "live" ? readClaimV2Semantic(db, target.claim_id) : null;
      if (priorSemantic === null || semanticKey(priorSemantic) !== target.semantic_key || priorSemantic.discriminator !== "assertion" ||
          !sameRef(priorSemantic.subject, target.subject) || priorSemantic.predicate !== target.predicate) {
        throw new ClaimError("provenance_unresolved", "native world endpoint target is not a live attested claim");
      }
    }
    // The immutable correction target attests the existing endpoint. It does
    // not mint an occurrence from the owner's replacement text or retain the
    // original source event after erasure. Admission checks the live prior;
    // restore checks this independent native attestation instead.
    return [];
  }
  const proofs: OccurrenceProof[] = [];
  for (const ref of assertionEndpoints(semantic)) {
    if (ref.kind === "supplied") {
      if (sourceKey === null) continue;
      if (!qualifiedSupplied(ref)) throw new ClaimError("provenance_unresolved", "qualified world supplied reference needs a source namespace");
      const found = cited.some(({ event }) =>
        ref.namespace.source_key === sourceKey && event.connector_id === ref.namespace.connector_id &&
        db.query("SELECT 1 FROM source_event_bindings WHERE event_id=? AND source_key=?").get(event.event_id, ref.namespace.source_key) !== null &&
        hasSubject(event, ref.id));
      if (!found) throw new ClaimError("provenance_unresolved", "supplied world reference is not present in its namespaced cited event");
      continue;
    }
    const match = cited.find(({ anchor, event }) => mintOccurrenceId({
      connector_id: event.connector_id, source_record_id: event.source_record_id, event_id: event.event_id,
      content_hash_version: event.content_hash_version, content_hash: event.content_hash, text_hash: event.text_hash,
      origin_binding: event.origin_binding, accepted_at: "",
    }, sourceKey, anchor) === ref.id);
    if (match === undefined) throw new ClaimError("provenance_unresolved", "occurrence world reference has no canonical cited-event proof");
    proofs.push({ occurrence_id: ref.id, event_id: match.event.event_id,
      content_hash_version: match.event.content_hash_version, event_content_hash: match.event.content_hash,
      text_hash: match.event.text_hash, origin_binding: match.event.origin_binding, accepted_at: match.row.accepted_at,
      source_key: sourceKey, start_utf16: match.anchor.start_utf16, end_utf16: match.anchor.end_utf16 });
  }
  return proofs;
}

/** Mints only references grounded by the exact immutable event revision. */
export function ensureClaimOccurrences(
  db: Database,
  semantic: ClaimV2Assertion,
  sourceKey: string | null,
): void {
  for (const proof of validateWorldEndpointProofs(db, semantic, sourceKey)) {
    const prior = db.query<{ event_id: string; content_hash_version: number; event_content_hash: string; text_hash: string; origin_binding: string; accepted_at: string; source_key: string | null; start_utf16: number; end_utf16: number }, [string]>(
      "SELECT * FROM claim_occurrences WHERE occurrence_id=?",
    ).get(proof.occurrence_id);
    if (prior !== null && (prior.event_id !== proof.event_id || prior.content_hash_version !== proof.content_hash_version || prior.event_content_hash !== proof.event_content_hash || prior.text_hash !== proof.text_hash || prior.origin_binding !== proof.origin_binding || prior.accepted_at !== proof.accepted_at || prior.source_key !== proof.source_key || prior.start_utf16 !== proof.start_utf16 || prior.end_utf16 !== proof.end_utf16)) throw new ClaimError("schema_invalid", "occurrence identity collision has a different mint tuple");
    if (prior === null) db.query(
      `INSERT INTO claim_occurrences(occurrence_id,event_id,content_hash_version,event_content_hash,text_hash,origin_binding,accepted_at,source_key,start_utf16,end_utf16)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(proof.occurrence_id, proof.event_id, proof.content_hash_version, proof.event_content_hash, proof.text_hash, proof.origin_binding, proof.accepted_at, proof.source_key, proof.start_utf16, proof.end_utf16);
  }
}

export function validateStoredClaimOccurrences(db: Database): void {
  for (const row of db.query<{ occurrence_id: string; event_id: string; content_hash_version: number; event_content_hash: string; text_hash: string; origin_binding: string; accepted_at: string; source_key: string | null; start_utf16: number; end_utf16: number }, []>("SELECT * FROM claim_occurrences").iterate()) {
    const stored = db.query<EventRow, [string]>("SELECT * FROM events WHERE event_id=?").get(row.event_id);
    if (stored === null) throw new ClaimError("schema_invalid", "stored occurrence proof is invalid");
    let event;
    try { event = eventFromRow(stored, db); } catch { throw new ClaimError("schema_invalid", "stored occurrence proof is invalid"); }
    const boundary = (offset: number) => offset >= 0 && offset <= event.text.length &&
      !(offset > 0 && offset < event.text.length &&
        event.text.charCodeAt(offset - 1) >= 0xd800 && event.text.charCodeAt(offset - 1) <= 0xdbff &&
        event.text.charCodeAt(offset) >= 0xdc00 && event.text.charCodeAt(offset) <= 0xdfff);
    const sourceValid = row.source_key === null
      ? event?.origin_binding_kind === "native" && db.query("SELECT 1 FROM native_owner_evidence WHERE event_id=? AND origin='correction'").get(row.event_id) !== null && db.query("SELECT 1 FROM source_event_bindings WHERE event_id=?").get(row.event_id) === null
      : db.query("SELECT 1 FROM source_event_bindings WHERE event_id=? AND source_key=?").get(row.event_id, row.source_key) !== null;
    if (!sourceValid || event.content_hash_version !== row.content_hash_version || event.content_hash !== row.event_content_hash || event.text_hash !== row.text_hash || event.origin_binding !== row.origin_binding || stored.accepted_at !== row.accepted_at || !boundary(row.start_utf16) || !boundary(row.end_utf16) || row.end_utf16 <= row.start_utf16 ||
      tuple([event.connector_id,row.source_key ?? "native-owner",event.source_record_id,row.event_id,String(event.content_hash_version),event.content_hash,event.text_hash,String(row.start_utf16),String(row.end_utf16)]) !== row.occurrence_id) throw new ClaimError("schema_invalid", "stored occurrence proof is invalid");
  }
}
