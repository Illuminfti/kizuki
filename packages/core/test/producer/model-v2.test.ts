import { afterEach, expect, test } from "bun:test";
import { EXTRACT_RESPONSE_V2_SCHEMA, type ProduceInputV2 } from "../../src/contracts/producer-v2";
import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR } from "../../src/producer/model-v2";
import { validateProduceResult } from "../../src/producer/result";
import { temporaryProducerContext, scriptedLlm } from "./helpers";

const input: ProduceInputV2 = {
  events: [{ event_id: "00000000000000000000000001", text: "Mira joined Northwind." }],
  supplied_refs: [{ id: "s0", anchors: [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }] }],
  vocabulary_refs: ["v-person"], predicates: [{ id: "classification.instance_of", object_kinds: ["vocabulary"] }],
  budget: { max_calls: 1, max_input_tokens: 20_000, max_output_tokens: 2_000 },
};
const response = { schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [{ id: "m0", label: "Mira", anchor: { event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }, candidate_refs: [{ kind: "supplied", id: "s0" }] }], claims: [{ id: "c0", subject: { kind: "mention", id: "m0" }, predicate: "classification.instance_of", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "v-person" } }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [], polarity: "positive", body: "Mira is a person.", valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "personal", anchors: [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }] }] };
const cleanups: (() => void)[] = []; afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function producer(script: Parameters<typeof scriptedLlm>[0]) { const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR); cleanups.push(temp.cleanup); const llm = scriptedLlm(script); return { port: createModelProducerV2Port(temp.ctx, { llm }), llm }; }

test("v2 consumes a real fenced prompt and returns local drafts without durable ids", async () => {
  expect(validateProduceResult({ status: "ok", response, usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }, "kizuki.producer/v2", { events: input.events, supplied_refs: input.supplied_refs, vocabulary_refs: input.vocabulary_refs, predicates: input.predicates }).result.status).toBe("ok");
  const { port, llm } = producer(request => { const prompt = request.messages[1]!.content; expect(prompt).toContain("<<<KZ-QUOTE"); expect(prompt).toContain("Mira joined Northwind."); return JSON.stringify(response); });
  const result = await port.produce(input);
  expect(result).toMatchObject({ status: "ok", response: { claims: [{ subject: { kind: "mention", id: "m0" } }] }, usage: { calls: 1 } });
  expect(llm.requests).toHaveLength(1);
});

test("v2 rejects injected fence leaks, invalid references and malformed anchors", async () => {
  for (const value of [JSON.stringify({ ...response, claims: [{ ...response.claims[0], subject: { kind: "supplied", id: "durable-id" } }] }), JSON.stringify({ ...response, mentions: [{ ...response.mentions[0], anchor: { event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 99 } }], claims: [] }), `{"schema":"${EXTRACT_RESPONSE_V2_SCHEMA}","mentions":[],"claims":[],"x":"<<<KZ-QUOTE"}`]) {
    const { port } = producer(() => value); expect((await port.produce(input)).status).toBe("rejected");
  }
});

test("v2 reserves one call and refuses an exhausted input budget before contacting a model", async () => {
  const { port, llm } = producer(() => JSON.stringify(response));
  expect(await port.produce({ ...input, budget: { ...input.budget, max_input_tokens: 1 } })).toMatchObject({ status: "rejected", reason: "budget_exhausted", usage: { calls: 0 } });
  expect(llm.requests).toHaveLength(0);
});
