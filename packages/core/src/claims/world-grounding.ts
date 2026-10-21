import type { Database } from "bun:sqlite";
import { rawSubjectRefKey } from "../contracts/claim-v2";
import { completeWorldAnchors, parseWorldAdmission, WORLD_GROUNDED_ADMISSION_SCHEMA, type WorldAdmission, type WorldGrounding } from "../contracts/world-admission";
import { readEvent } from "../ledger/ledger";
import { requireSourceEvents, type SourceReadScope } from "../ledger/source-grants";
import { canonicalJson, sha256Hex } from "../util/hash";
import { semanticKey, supportKey, type ClaimV2SupportEventRef } from "./claim-v2-keys";
import { ClaimError } from "./errors";
import { validateWorldEndpointProofs } from "./occurrences";

export const MAX_GROUNDING_EVENTS = 4;
export const MAX_GROUNDING_ADMISSION_BYTES = 32_768;
/** Kept only inside one synchronous read frame; never reused for admission or restore. */
export type GroundingReadCache = Map<string, readonly ClaimV2SupportEventRef[]>;
const invalid = (): never => { throw new ClaimError("provenance_unresolved", "world identity grounding is unavailable"); };
export function groundingDigest(admission: WorldAdmission): string | undefined {
  return admission.schema === WORLD_GROUNDED_ADMISSION_SCHEMA ? sha256Hex(canonicalJson(admission.grounding)) : undefined;
}
export function witnessEventIds(admission: WorldAdmission): readonly string[] {
  return [...new Set(completeWorldAnchors(admission.semantic).map(a => a.event_id))].sort();
}

/**
 * Validate four exact v1 source admissions. Grounding is a dependency of the
 * identity statement, never evidence that the statement itself is true.
 * Restore accepts retained retired claims; current grouping separately proves
 * both endpoint classifications under its current/historical read frame.
 */
export function validateWorldGrounding(
  db: Database,
  grounding: readonly WorldGrounding[],
  options: { readonly restore?: boolean; readonly scope?: SourceReadScope; readonly charge?: (value: string) => void; readonly cache?: GroundingReadCache } = {},
): readonly ClaimV2SupportEventRef[] {
  const events = new Map<string, ClaimV2SupportEventRef>();
  for (const proof of grounding) for (const kind of ["classification", "label"] as const) {
    const pin = proof[kind];
    const cacheKey = canonicalJson([proof.endpoint, kind, pin]);
    const cached = options.restore === true ? options.cache?.get(cacheKey) : undefined;
    if (cached !== undefined) {
      for (const event of cached) events.set(event.event_id, event);
      if (events.size > MAX_GROUNDING_EVENTS) invalid();
      continue;
    }
    const row = db.query<{ admission: string; source_key: string; grant_revision: number; anchors: string; status: string }, [string, string]>(
      `SELECT s.admission,s.source_key,s.grant_revision,s.anchors,c.status FROM claim_v2_support s JOIN claims c USING(claim_id)
       WHERE s.support_key=? AND s.claim_id=? AND s.support_origin='source' AND c.is_world_typed=1`,
    ).get(pin.support_key, pin.claim_id);
    if (!row || Buffer.byteLength(row.admission, "utf8") > MAX_GROUNDING_ADMISSION_BYTES || (options.restore ? row.status === "purged" : row.status !== "live") || sha256Hex(row.admission) !== pin.admission_hash) invalid();
    options.charge?.(row!.admission);
    let value: unknown;
    try { value = JSON.parse(row!.admission); } catch { invalid(); }
    const admitted = parseWorldAdmission(value);
    if (!admitted || admitted.schema !== "kizuki.world-admission/v1" || canonicalJson(admitted) !== row!.admission) invalid();
    const semantic = admitted!.semantic;
    if (rawSubjectRefKey(semantic.subject) !== rawSubjectRefKey(proof.endpoint) || semantic.polarity !== "positive" ||
        semantic.context.length !== 0 || semantic.perspective.mode !== "asserted" || semantic.perspective.holder !== null ||
        semantic.perspective.speaker !== null || semantic.perspective.addressee !== null ||
        (kind === "classification"
          ? semantic.predicate !== "world.kind" || semantic.object.kind !== "vocabulary" || semantic.object.ref.id !== "world/concept"
          : semantic.predicate !== "concept.label" || semantic.object.kind !== "literal" || semantic.object.value.trim().length === 0)) invalid();
    const pins = db.query<ClaimV2SupportEventRef, [string]>(
      "SELECT event_id,event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id",
    ).all(pin.support_key);
    if (pins.length === 0 || pins.length > MAX_GROUNDING_EVENTS || canonicalJson(pins) !== canonicalJson(pin.events) ||
        db.query("SELECT 1 FROM claim_v2_semantics WHERE claim_id=? AND semantic_key=?").get(pin.claim_id, semanticKey(semantic)) === null) invalid();
    const anchors = completeWorldAnchors(semantic);
    if (canonicalJson(anchors) !== row!.anchors || anchors.some(a => !pins.some(p => p.event_id === a.event_id)) ||
        supportKey({ semantic_key: semanticKey(semantic), source_key: row!.source_key, grant_revision: row!.grant_revision, events: pins, anchors }) !== pin.support_key) invalid();
    validateWorldEndpointProofs(db, semantic, row!.source_key, { restore: true });
    for (const pin of pins) {
      const event = readEvent(db, pin.event_id);
      if (!event || (!options.restore && event.deleted) || event.content_hash !== pin.event_content_hash || event.origin !== "external" ||
          db.query("SELECT 1 FROM source_event_bindings WHERE event_id=? AND source_key=?").get(pin.event_id, row!.source_key) === null) invalid();
      if (!events.has(pin.event_id)) options.charge?.(event!.text);
      events.set(pin.event_id, pin);
    }
    if (events.size > MAX_GROUNDING_EVENTS) invalid();
    if (options.restore === true) options.cache?.set(cacheKey, pins);
  }
  const result = [...events.values()].sort((a, b) => a.event_id.localeCompare(b.event_id));
  if (options.scope) requireSourceEvents(db, result.map(p => p.event_id), options.scope);
  return result;
}

/** Single dispatch; v1 source ownership and native-owner attestation are unchanged. */
export function validateWorldAdmissionProofs(
  db: Database, admission: WorldAdmission, sourceKey: string | null,
  options: { readonly restore?: boolean; readonly scope?: SourceReadScope; readonly charge?: (value: string) => void; readonly cache?: GroundingReadCache } = {},
): readonly ClaimV2SupportEventRef[] {
  if (admission.schema !== WORLD_GROUNDED_ADMISSION_SCHEMA) {
    validateWorldEndpointProofs(db, admission.semantic, sourceKey, options);
    return [];
  }
  if (sourceKey === null) invalid();
  const events = validateWorldGrounding(db, admission.grounding, options);
  // Every semantic anchor is a real witness from this contribution's source.
  // A model cannot promote a grounding quotation into an additional witness.
  for (const id of witnessEventIds(admission)) {
    if (events.some(e => e.event_id === id) || db.query("SELECT 1 FROM source_event_bindings WHERE event_id=? AND source_key=?").get(id, sourceKey!) === null) invalid();
  }
  return events;
}
