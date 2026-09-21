import type { Database } from "bun:sqlite";
import type { ClaimV2Assertion, RawSubjectRef } from "../contracts/claim-v2";
import type { TextAnchor } from "../contracts/producer-v2";
import { sha256Hex } from "../util/hash";
import { utf8ByteLength } from "../util/validate";
import { assertionEndpoints } from "../world/allocation";
import { ClaimError } from "./errors";

export interface OccurrenceEventIdentity {
  readonly connector_id: string; readonly source_record_id: string; readonly event_id: string;
  readonly content_hash_version: number; readonly content_hash: string; readonly text_hash: string;
  readonly origin_binding: string; readonly accepted_at: string;
}
export interface WorldOccurrenceDraft { readonly anchor: TextAnchor; readonly label: string; }
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

/** Mints only references grounded by the exact immutable event revision. */
export function ensureClaimOccurrences(
  db: Database,
  semantic: ClaimV2Assertion,
  sourceKey: string | null,
): void {
  for (const ref of assertionEndpoints(semantic)) {
    if (ref.kind === "supplied") {
      const found = anchors(semantic).some((anchor) => {
        const row = db.query<{ subjects: string }, [string]>("SELECT subjects FROM events WHERE event_id=?").get(anchor.event_id);
        if (row === null) return false;
        try { return (JSON.parse(row.subjects) as unknown[]).some((subject) =>
          typeof subject === "object" && subject !== null && (subject as { subject_id?: unknown }).subject_id === ref.id);
        } catch { return false; }
      });
      if (!found) throw new ClaimError("provenance_unresolved", "supplied world reference is not present in cited event subjects");
      continue;
    }
    const anchor = anchors(semantic).find((candidate) => {
      const row = db.query<{ connector_id: string; source_record_id: string; content_hash_version: number; content_hash: string; text_hash: string }, [string]>(
        "SELECT connector_id,source_record_id,content_hash_version,content_hash,text_hash FROM events WHERE event_id=?",
      ).get(candidate.event_id);
      return row !== null && mintOccurrenceId({ ...row, event_id: candidate.event_id, origin_binding: "", accepted_at: "" }, sourceKey, candidate) === ref.id;
    });
    if (anchor === undefined) throw new ClaimError("provenance_unresolved", "occurrence world reference has no canonical cited-event proof");
    const row = db.query<{ connector_id: string; content_hash_version: number; content_hash: string; text_hash: string }, [string]>(
      "SELECT connector_id,content_hash_version,content_hash,text_hash FROM events WHERE event_id=?",
    ).get(anchor.event_id);
    if (row === null) throw new ClaimError("provenance_unresolved", "occurrence event is missing");
    const prior = db.query<{ event_id: string; content_hash_version: number; event_content_hash: string; text_hash: string; origin_binding: string; accepted_at: string; source_key: string | null; start_utf16: number; end_utf16: number }, [string]>(
      "SELECT * FROM claim_occurrences WHERE occurrence_id=?",
    ).get(ref.id);
    const identity = db.query<{ origin_binding: string; accepted_at: string }, [string]>("SELECT origin_binding,accepted_at FROM events WHERE event_id=?").get(anchor.event_id);
    if (identity === null) throw new ClaimError("provenance_unresolved", "occurrence event is missing");
    const proof = { event_id: anchor.event_id,
      content_hash_version: row.content_hash_version, event_content_hash: row.content_hash, text_hash: row.text_hash, origin_binding: identity.origin_binding, accepted_at: identity.accepted_at, source_key: sourceKey,
      start_utf16: anchor.start_utf16, end_utf16: anchor.end_utf16 };
    if (prior !== null && (prior.event_id !== proof.event_id || prior.content_hash_version !== proof.content_hash_version || prior.event_content_hash !== proof.event_content_hash || prior.text_hash !== proof.text_hash || prior.origin_binding !== proof.origin_binding || prior.accepted_at !== proof.accepted_at || prior.source_key !== proof.source_key || prior.start_utf16 !== proof.start_utf16 || prior.end_utf16 !== proof.end_utf16)) throw new ClaimError("schema_invalid", "occurrence identity collision has a different mint tuple");
    if (prior === null) db.query(
      `INSERT INTO claim_occurrences(occurrence_id,event_id,content_hash_version,event_content_hash,text_hash,origin_binding,accepted_at,source_key,start_utf16,end_utf16)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(ref.id, proof.event_id, proof.content_hash_version, proof.event_content_hash, proof.text_hash, proof.origin_binding, proof.accepted_at, proof.source_key, proof.start_utf16, proof.end_utf16);
  }
}

export function validateStoredClaimOccurrences(db: Database): void {
  for (const row of db.query<{ occurrence_id: string; event_id: string; content_hash_version: number; event_content_hash: string; text_hash: string; origin_binding: string; accepted_at: string; source_key: string | null; start_utf16: number; end_utf16: number }, []>("SELECT * FROM claim_occurrences").iterate()) {
    const event = db.query<{ connector_id: string; source_record_id: string; content_hash_version: number; content_hash: string; text_hash: string; origin_binding: string; accepted_at: string; text: string; origin_binding_kind: string }, [string]>("SELECT connector_id,source_record_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at,text,origin_binding_kind FROM events WHERE event_id=?").get(row.event_id);
    const boundary = (offset: number) => offset >= 0 && offset <= event!.text.length &&
      !(offset > 0 && offset < event!.text.length && /[\\uD800-\\uDBFF]/.test(event!.text[offset - 1]!) && /[\\uDC00-\\uDFFF]/.test(event!.text[offset]!));
    const sourceValid = row.source_key === null
      ? event?.origin_binding_kind === "native" && db.query("SELECT 1 FROM native_owner_evidence WHERE event_id=? AND origin='correction'").get(row.event_id) !== null && db.query("SELECT 1 FROM source_event_bindings WHERE event_id=?").get(row.event_id) === null
      : db.query("SELECT 1 FROM source_event_bindings WHERE event_id=? AND source_key=?").get(row.event_id, row.source_key) !== null;
    if (event === null || !sourceValid || event.content_hash_version !== row.content_hash_version || event.content_hash !== row.event_content_hash || event.text_hash !== row.text_hash || event.origin_binding !== row.origin_binding || event.accepted_at !== row.accepted_at || !boundary(row.start_utf16) || !boundary(row.end_utf16) || row.end_utf16 <= row.start_utf16 ||
      tuple([event.connector_id,row.source_key ?? "native-owner",event.source_record_id,row.event_id,String(event.content_hash_version),event.content_hash,event.text_hash,String(row.start_utf16),String(row.end_utf16)]) !== row.occurrence_id) throw new ClaimError("schema_invalid", "stored occurrence proof is invalid");
  }
}
