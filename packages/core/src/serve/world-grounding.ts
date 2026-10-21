import type { Database } from "bun:sqlite";
import { OWNER } from "../agents";
import { MAX_GROUNDING_ADMISSION_BYTES, validateWorldGrounding } from "../claims/world-grounding";
import { rawSubjectRefKey, type RawSubjectRef } from "../contracts/claim-v2";
import type { CaptureEvent } from "../contracts/event";
import type { ProduceInputV2, ProducerV2Port } from "../contracts/producer-v2";
import { parseWorldAdmission, type WorldGrounding, type WorldGroundingPin } from "../contracts/world-admission";
import { readEvent } from "../ledger/ledger";
import { sourceExtractionSql, sourceEventsAllowed, sourcePortBindingDigest } from "../ledger/source-grants";
import { planModelExtractionV2 } from "../producer";
import { canonicalJson, sha256Hex } from "../util/hash";
import { heldClaimSql } from "../world/corroboration";
import { authorizedSupportSql } from "../world/policy-sql";
import { worldProduceInput, type WorldRequestBudget } from "./extract-v2";
import { worldSuppliedReferences } from "./world-supplied";

export interface GroundedWorldInput {
  readonly input: ProduceInputV2;
  readonly events: readonly CaptureEvent[];
  readonly refs: ReadonlyMap<string, RawSubjectRef>;
  readonly grounding: ReadonlyMap<string, WorldGrounding>;
}
const sourceKey = (db: Database, eventId: string): string | null =>
  db.query<{ source_key: string }, [string]>("SELECT source_key FROM source_event_bindings WHERE event_id=?").get(eventId)?.source_key ?? null;

/** Two endpoint candidates, four proof pins/events at most. No denied row occupies a candidate slot. */
export function groundedWorldInput(
  db: Database, witnesses: readonly CaptureEvent[], budget: WorldRequestBudget, producer?: ProducerV2Port,
): GroundedWorldInput {
  const base = worldSuppliedReferences(witnesses, id => sourceKey(db, id));
  const fallback: GroundedWorldInput = { input: worldProduceInput(witnesses, base.input, budget), events: witnesses, refs: base.refs, grounding: new Map() };
  if (!producer || witnesses.length > 6 || witnesses.length === 0) return fallback;
  const egress = sourceExtractionSql(db, producer);
  const permit = authorizedSupportSql({ db, vaultPath: "", principal: OWNER, sourcePurpose: "extract" });
  const permitted = { sql: `${permit.sql} AND json_extract(s.admission,'$.schema')='kizuki.world-admission/v1'
    AND s.support_origin='source' AND length(CAST(s.admission AS BLOB))<=${MAX_GROUNDING_ADMISSION_BYTES}
    AND json_extract(s.admission,'$.semantic.perspective.mode')='asserted'
    AND json_extract(s.admission,'$.semantic.perspective.holder') IS NULL
    AND json_extract(s.admission,'$.semantic.perspective.speaker') IS NULL
    AND json_extract(s.admission,'$.semantic.perspective.addressee') IS NULL
    AND json_array_length(s.admission,'$.semantic.context')=0
    AND NOT EXISTS(SELECT 1 FROM claim_v2_support_events pe JOIN events ON events.event_id=pe.event_id
      WHERE pe.support_key=s.support_key AND NOT (${egress.sql}))`, bindings: [...permit.bindings, ...egress.bindings] };
  const hold = heldClaimSql("base", permitted);
  const text = witnesses.map(e => e.text).join("\n");
  const candidates = db.query<{ admission: string; claim_id: string; support_key: string }, (string | number)[]>(
    `SELECT s.admission,s.claim_id,s.support_key FROM claim_v2_support s JOIN claims base USING(claim_id)
      JOIN claim_v2_semantics m USING(claim_id)
     WHERE base.status='live' AND m.predicate='concept.label' AND m.polarity='positive' AND ${permitted.sql}
       AND json_extract(s.admission,'$.semantic.object.kind')='literal'
       AND length(json_extract(s.admission,'$.semantic.object.value')) BETWEEN 1 AND 120
       AND instr(?,json_extract(s.admission,'$.semantic.object.value'))>0
       AND NOT (${hold.sql}) ORDER BY s.support_key LIMIT 8`,
  ).all(...permitted.bindings, text, ...hold.bindings);
  const chosen: { proof: WorldGrounding; events: CaptureEvent[] }[] = [];
  const endpoints = new Set<string>();
  for (const label of candidates) {
    const admission = parseWorldAdmission(JSON.parse(label.admission));
    if (!admission || admission.schema !== "kizuki.world-admission/v1") continue;
    const endpoint = admission.semantic.subject, key = rawSubjectRefKey(endpoint);
    if (endpoints.has(key)) continue;
    const classification = db.query<{ admission: string; claim_id: string; support_key: string }, (string | number)[]>(
      `SELECT s.admission,s.claim_id,s.support_key FROM claim_v2_support s JOIN claims base USING(claim_id)
         JOIN claim_v2_semantics m USING(claim_id)
       WHERE base.status='live' AND m.predicate='world.kind' AND m.polarity='positive' AND ${permitted.sql}
         AND json_extract(s.admission,'$.semantic.subject')=json(?)
         AND json_extract(s.admission,'$.semantic.object.ref.id')='world/concept'
         AND NOT (${hold.sql}) ORDER BY s.support_key LIMIT 1`,
    ).get(...permitted.bindings, canonicalJson(endpoint), ...hold.bindings);
    if (!classification) continue;
    const pin = (row: typeof label): WorldGroundingPin => ({ claim_id: row.claim_id, support_key: row.support_key, admission_hash: sha256Hex(row.admission),
      events: db.query<{ event_id: string; event_content_hash: string }, [string]>("SELECT event_id,event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id").all(row.support_key) });
    const proof: WorldGrounding = { endpoint, classification: pin(classification), label: pin(label) };
    let pins;
    try { pins = validateWorldGrounding(db, [proof], { scope: { owner: false, purpose: "extract", model: true, port: producer } }); }
    catch { continue; }
    if (pins.some(p => witnesses.some(w => w.event_id === p.event_id))) continue;
    const events = pins.map(p => readEvent(db, p.event_id));
    if (events.some(e => e === null || e.deleted || e.origin !== "external")) continue;
    chosen.push({ proof, events: events as CaptureEvent[] }); endpoints.add(key);
    if (chosen.length === 2) break;
  }
  // Both endpoints must have complete proof in this same request. Partial
  // catalogs are never issued and therefore cannot imply an absent counterpart.
  if (chosen.length !== 2) return fallback;
  const grounding = new Map<string, WorldGrounding>();
  const refs = new Map<string, RawSubjectRef>(base.refs);
  const extra = new Map(chosen.flatMap(c => c.events).map(e => [e.event_id, e]));
  if (extra.size > 4 || witnesses.length + extra.size > 8) return fallback;
  const events = [...witnesses, ...extra.values()];
  const supplied = [...base.input];
  const request = sha256Hex(canonicalJson({
    events: witnesses.map(e => [e.event_id, e.content_hash]),
    proofs: chosen.map(c => c.proof), budget: { max_input_tokens: budget.max_input_tokens, max_output_tokens: budget.max_output_tokens }, port: sourcePortBindingDigest(producer),
    revisions: events.map(e => db.query<{ source_key: string; revision: number }, [string]>(
      "SELECT b.source_key,g.revision FROM source_event_bindings b JOIN source_grants g USING(source_key) WHERE b.event_id=?",
    ).get(e.event_id)),
  }));
  for (const candidate of chosen) {
    const label = parseWorldAdmission(JSON.parse(db.query<{ admission: string }, [string]>("SELECT admission FROM claim_v2_support WHERE support_key=?").get(candidate.proof.label.support_key)!.admission))!;
    const id = `g${request}/${grounding.size}`;
    refs.set(id, candidate.proof.endpoint); grounding.set(id, candidate.proof);
    supplied.push({ id, anchors: label.semantic.anchors });
  }
  const input = worldProduceInput(events, supplied, budget);
  try { if (planModelExtractionV2(input).status !== "ready") return fallback; } catch { return fallback; }
  if (!sourceEventsAllowed(db, events.map(e => e.event_id), { owner: false, purpose: "extract", model: true, port: producer })) return fallback;
  return { input, events, refs, grounding };
}
