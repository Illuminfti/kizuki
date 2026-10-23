import { expect, test } from "bun:test";
import fixture from "../fixtures/producer-local-alias.json";
import { parseExtractResponseV2, type ExtractResponseV2, type ProduceInputV2 } from "../../src/contracts/producer-v2";
import type { WorldGrounding } from "../../src/contracts/world-admission";
import type { RawSubjectRef } from "../../src/contracts/claim-v2";
import { mintOccurrenceId } from "../../src/claims/occurrences";
import { resolveModelExtractionWire } from "../../src/producer/model-v2-wire";
import { prepareWorldDrafts, type WorldDraftContext } from "../../src/producer/world-drafts";
import { canonicalJson, sha256Hex } from "../../src/util/hash";

function local() {
  const input = structuredClone(fixture.input) as ProduceInputV2;
  expect(sha256Hex(fixture.model_response)).toBe(fixture.model_response_sha256);
  const { budget: _budget, ...parseInput } = input;
  const mapped = resolveModelExtractionWire(fixture.model_response, parseInput);
  if (!mapped.ok) throw new Error("synthetic wire did not map");
  const parsed = parseExtractResponseV2(mapped.text, parseInput);
  if (!parsed.ok || parsed.dropped.length) throw new Error("synthetic wire did not parse");
  const events = input.events.map((event, index) => ({ ...event, connector_id: "local-alias.fixture", source_record_id: event.event_id,
    source_key: String(index + 100).padStart(26, "0"), content_hash_version: 1, content_hash: sha256Hex(canonicalJson(event)),
    text_hash: sha256Hex(event.text), origin_binding: "external", accepted_at: "2000-01-01T00:00:00.000Z", subjects: [] }));
  const context: WorldDraftContext = { events, supplied_refs: new Map(), model_ref: "synthetic-regression",
    witness_event_ids: new Set(events.map(event => event.event_id)), sent_evidence_windows: events.map(event => ({ event_id: event.event_id, start_utf16: 0, end_utf16: event.text.length, text: event.text })) };
  return { input, response: structuredClone(parsed.response), context };
}

function occurrence(f: ReturnType<typeof local>, id: string) {
  const mention = f.response.mentions.find(mention => mention.id === id)!;
  return { kind: "occurrence" as const, id: mintOccurrenceId(f.context.events[0]!, f.context.events[0]!.source_key, mention.anchor) };
}

// These unit fixtures stand for host-owned capabilities, not durable writer proof.
// The real catalog/writer controls are exercised by serve/identity-grounding.test.ts.
function catalog(f: ReturnType<typeof local>) {
  const grounding = new Map<string, WorldGrounding>();
  for (const [index, handle] of ["g0", "g1"].entries()) {
    const pin = { claim_id: String(index + 1).padStart(26, "0"), support_key: "a".repeat(64), admission_hash: "b".repeat(64), events: [{ event_id: f.input.events[0]!.event_id, event_content_hash: "c".repeat(64) }] };
    grounding.set(handle, { endpoint: { kind: "occurrence", id: String(index + 1).repeat(64) }, classification: pin, label: pin });
  }
  const input: ProduceInputV2 = { ...f.input, supplied_refs: [...grounding.keys()].map(id => ({ id, anchors: [] })) };
  const context: WorldDraftContext = { ...f.context, grounding, supplied_refs: new Map([...grounding].map(([id, proof]) => [id, proof.endpoint])) };
  return { input, context, grounding };
}

function nominate(response: ExtractResponseV2, id: string, candidates: ExtractResponseV2["mentions"][number]["candidate_refs"]): ExtractResponseV2 {
  return { ...response, mentions: response.mentions.map(mention => mention.id === id ? { ...mention, candidate_refs: candidates } : mention) };
}

test("sealed local alias wire prepares all ten claims without merging endpoints or synthesizing a definition", () => {
  const f = local(), before = canonicalJson(f.response);
  const prepared = prepareWorldDrafts(f.response, f.input, f.context);
  expect(prepared.dropped).toEqual([]); expect(prepared.drafts).toHaveLength(10);
  const alias = occurrence(f, "m2"), first = occurrence(f, "m1");
  expect(alias).not.toEqual(first);
  expect(prepared.drafts.filter(draft => draft.semantic.subject.id === alias.id).map(draft => draft.semantic.predicate)).toEqual(["world.kind", "concept.label"]);
  expect(prepared.drafts.find(draft => draft.semantic.predicate === "concept.same_as")!.semantic).toMatchObject({ subject: first, object: { kind: "subject", ref: alias } });
  expect(prepared.drafts.every(draft => draft.world_admission.schema === "kizuki.world-admission/v1")).toBe(true);
  expect(canonicalJson(f.response)).toBe(before);
});

test("forward and cyclic local nominations remain metadata and cannot change occurrence identities", () => {
  const f = local();
  const cycle = nominate(f.response, "m1", [{ kind: "mention", id: "m2" }]);
  const baseline = prepareWorldDrafts({ ...f.response, mentions: f.response.mentions.map(mention => ({ ...mention, candidate_refs: [] })) }, f.input, f.context);
  const { budget: _budget, ...parseInput } = f.input;
  const parsed = parseExtractResponseV2(JSON.stringify(cycle), parseInput);
  expect(parsed.ok).toBe(true);
  expect(prepareWorldDrafts(cycle, f.input, f.context)).toEqual(baseline);
});

test("local nomination chains never borrow a candidate's host grounding, while direct host endpoints still work", () => {
  const f = local(), c = catalog(f);
  let response = nominate(f.response, "m1", [{ kind: "supplied", id: "g0" }]);
  response = nominate(response, "m3", [{ kind: "supplied", id: "g1" }]);
  const prepared = prepareWorldDrafts(response, c.input, c.context);
  // m2 -> m1 -> g0 is never traversed. Its mixed local/host identity is dropped.
  expect(prepared.dropped).toEqual([{ reason: "invalid_claim", id: "c9" }]);
  expect(prepared.drafts).toHaveLength(9);
  const distinct = prepared.drafts.find(draft => draft.semantic.predicate === "concept.distinguished_from")!;
  expect(distinct.world_admission.schema).toBe("kizuki.world-admission/v2");
  expect(distinct.semantic).toMatchObject({ subject: c.grounding.get("g0")!.endpoint, object: { kind: "subject", ref: c.grounding.get("g1")!.endpoint } });
  response = nominate(response, "m2", [{ kind: "supplied", id: "g1" }]);
  const direct = prepareWorldDrafts(response, c.input, c.context);
  expect(direct.dropped).toEqual([]);
  expect(direct.drafts.find(draft => draft.semantic.predicate === "concept.same_as")!.world_admission.schema).toBe("kizuki.world-admission/v2");
});

test("mixed and stale supplied candidates retain the existing fail-closed refusal", () => {
  const f = local(), c = catalog(f);
  const mixed = nominate(f.response, "m2", [{ kind: "mention", id: "m1" }, { kind: "supplied", id: "g0" }]);
  expect(() => prepareWorldDrafts(mixed, c.input, c.context)).toThrow("identity candidate is not a host-issued endpoint");
  const raw: RawSubjectRef = { kind: "supplied", id: "catalog-target", namespace: { connector_id: "local-alias.fixture", source_key: f.context.events[0]!.source_key! } };
  const stale = { ...c.context, grounding: new Map<string, WorldGrounding>(), supplied_refs: new Map([["g0", raw], ["g1", raw]]) };
  const nominated = nominate(f.response, "m2", [{ kind: "supplied", id: "g0" }]);
  expect(() => prepareWorldDrafts(nominated, c.input, stale)).toThrow("identity candidate is not a host-issued endpoint");
});
