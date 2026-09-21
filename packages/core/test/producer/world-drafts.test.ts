import { expect, test } from "bun:test";
import { EXTRACT_RESPONSE_V2_SCHEMA, type ExtractResponseV2, type ProduceInputV2 } from "../../src/contracts/producer-v2";
import { mintOccurrenceId, type OccurrenceEventIdentity } from "../../src/claims/occurrences";
import { prepareWorldDrafts, type WorldDraftContext } from "../../src/producer/world-drafts";
import type { InsertClaimInput } from "../../src/claims/store";

const eventId = "00000000000000000000000001";
const anchor = { event_id: eventId, start_utf16: 0, end_utf16: 4 } as const;
const input: ProduceInputV2 = { events: [{ event_id: eventId, text: "Mira joined Northwind." }], supplied_refs: [{ id: "s0", anchors: [anchor] }], vocabulary_refs: ["v-person"], predicates: [{ id: "classification.instance_of", object_kinds: ["vocabulary"] }], budget: { max_calls: 1, max_input_tokens: 1000, max_output_tokens: 1000 } };
const event: OccurrenceEventIdentity = { connector_id: "fixture", source_record_id: "r1", event_id: eventId, content_hash_version: 1, content_hash: "a".repeat(64), text_hash: "b".repeat(64), origin_binding: "origin", accepted_at: "2026-01-01T00:00:00.000Z" };
const context: WorldDraftContext = { events: [{ ...event, source_key: "source-1", text: input.events[0]!.text, subjects: [{ kind: "supplied", id: "subject-1" }] }], supplied_refs: new Map([["s0", { kind: "supplied", id: "subject-1" }]]), model_ref: "fixture-model" };
const response: ExtractResponseV2 = { schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [{ id: "m0", label: "Mira", anchor, candidate_refs: [{ kind: "supplied", id: "s0" }] }], claims: [{ id: "c0", subject: { kind: "mention", id: "m0" }, predicate: "classification.instance_of", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "v-person" } }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [], polarity: "positive", body: "Mira is a person.", valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "personal", anchors: [anchor] }] };

test("grounds local mentions in the exact immutable event tuple and preserves model-only admission", () => {
  const [draft] = prepareWorldDrafts(response, input, context);
  expect(draft).toMatchObject({ producer: "model", model_ref: "fixture-model", semantic: { subject: { kind: "occurrence", id: mintOccurrenceId(event, "source-1", anchor) }, temporal_basis: "unknown", valid_from: null, valid_to: null }, world_admission: { authority: "model_inference", confidence: 0.8, epistemicKind: "model_inference", rendering: { body: "Mira is a person." } } });
  const insert: InsertClaimInput = draft!;
  expect(insert.provenance).toEqual([eventId]);
});

test("rejects forged supplied subjects, unsupported mentions, and anchors outside the selected event", () => {
  expect(() => prepareWorldDrafts({ ...response, claims: [{ ...response.claims[0]!, subject: { kind: "supplied", id: "s0" } }] }, input, { ...context, supplied_refs: new Map([["s0", { kind: "supplied", id: "forged" }]]) })).toThrow("absent from its cited event");
  expect(() => prepareWorldDrafts({ ...response, claims: [{ ...response.claims[0]!, subject: { kind: "mention", id: "m0" }, anchors: [{ ...anchor, start_utf16: 5, end_utf16: 6 }] }] }, input, context)).toThrow("unsupported by claim evidence");
  expect(() => prepareWorldDrafts({ ...response, mentions: [{ ...response.mentions[0]!, anchor: { event_id: "00000000000000000000000002", start_utf16: 0, end_utf16: 4 } }] }, input, context)).toThrow("outside immutable event input");
});

test("rejects a semantic endpoint whose supplied handle lacks cited support", () => {
  expect(() => prepareWorldDrafts({ ...response, claims: [{ ...response.claims[0]!, subject: { kind: "supplied", id: "s0" }, anchors: [{ ...anchor, start_utf16: 5, end_utf16: 10 }] }] }, input, context)).toThrow("unsupported by claim evidence");
});
