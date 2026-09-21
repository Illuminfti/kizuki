import { afterEach, expect, test } from "bun:test";
import { EXTRACT_RESPONSE_V2_SCHEMA, type ProduceInputV2 } from "../../src/contracts/producer-v2";
import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR } from "../../src/producer/model-v2";
import { validateProduceResult } from "../../src/producer/result";
import { temporaryProducerContext, scriptedLlm } from "./helpers";
import { WORLD_VOCABULARY } from "../../src/contracts/world-vocabulary";
import type { SystemOnePort, SystemOneRequest, SystemOneResponse } from "../../src/contracts/systemone";
import { PortError, validatePortDescriptor } from "../../src/contracts/ports";

const input: ProduceInputV2 = {
  events: [{ event_id: "00000000000000000000000001", text: "Mira joined Northwind." }],
  supplied_refs: [{ id: "s0", anchors: [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }] }],
  vocabulary_refs: ["v-person"], predicates: [{ id: "classification.instance_of", object_kinds: ["vocabulary"] }],
  budget: { max_calls: 1, max_input_tokens: 20_000, max_output_tokens: 2_000 },
};
const response = { schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [{ id: "m0", label: "Mira", anchor: { event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }, candidate_refs: [{ kind: "supplied", id: "s0" }] }], claims: [{ id: "c0", subject: { kind: "mention", id: "m0" }, predicate: "classification.instance_of", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "v-person" } }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [], polarity: "positive", body: "Mira is a person.", valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "personal", anchors: [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }] }] };
const cleanups: (() => void)[] = []; afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function producer(script: Parameters<typeof scriptedLlm>[0]) { const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR); cleanups.push(temp.cleanup); const llm = scriptedLlm(script); return { port: createModelProducerV2Port(temp.ctx, { llm }), llm }; }

function judgedProducer(evaluate: (request: SystemOneRequest) => Promise<SystemOneResponse>, model_ref: string | null = "test-judge") {
  const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR);
  cleanups.push(temp.cleanup);
  const judge: SystemOnePort = {
    descriptor: validatePortDescriptor({ id: "test.systemone.v2", kind: "systemone", contract: "kizuki.systemone/v1", contract_minor: 0, supports: ["evaluate"], requires_lease: false, optional_package: null }),
    model_ref, evaluate, async health() { return { status: "ready", detail: {} }; }, async close() {},
  };
  const llm = scriptedLlm(() => JSON.stringify(response));
  return createModelProducerV2Port(temp.ctx, { llm, systemone: judge });
}

test("v2 honors configured typed admission before returning extracted claims", async () => {
  let calls = 0;
  const port = judgedProducer(async request => {
    calls++;
    expect(request.state).toMatchObject({ events: input.events, mentions: response.mentions, claims: response.claims });
    expect(request.questions).toHaveProperty("admit_0");
    return { model: "test-judge", answers: { admit_0: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  expect(await port.produce(input)).toMatchObject({ status: "ok", response: { claims: [] }, dropped: [{ reason: "systemone_rejected", id: "c0" }] });
  expect(calls).toBe(1);
  const accepted = judgedProducer(async () => ({ model: "test-judge", answers: { admit_0: { type: "noul", noul: 0.94 } }, usage: { input_tokens: 1, output_tokens: 1 } }));
  expect(await accepted.produce(input)).toMatchObject({ status: "ok", response: { claims: response.claims } });
});

test("v2 fails closed for an unavailable or malformed configured judge", async () => {
  const unavailable = judgedProducer(async () => { throw new PortError("unavailable", "private provider details", true); });
  expect(await unavailable.produce(input)).toMatchObject({ status: "unavailable", reason: "unavailable", usage: { calls: 1 } });
  for (const answers of [{}, { admit_0: { type: "noul", noul: NaN } }, { admit_0: { type: "noul", noul: 2 } }, { admit_0: { type: "noul", noul: 0.9 }, extra: { type: "noul", noul: 1 } }]) {
    const port = judgedProducer(async () => ({ model: "test-judge", answers, usage: { input_tokens: 1, output_tokens: 1 } }) as SystemOneResponse);
    expect(await port.produce(input)).toMatchObject({ status: "rejected", reason: "schema_invalid" });
  }
  const disabled = judgedProducer(async () => { throw new Error("must not evaluate"); }, null);
  expect((await disabled.health()).status).toBe("unavailable");
  expect(await disabled.produce(input)).toMatchObject({ status: "unavailable", reason: "unavailable" });
});

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

test("v2 rejects unknown keys, malformed budgets, and invalid trusted anchors before a prompt or call", async () => {
  const cases: unknown[] = [
    { ...input, extra: true },
    { ...input, budget: { ...input.budget, max_calls: 2 } },
    { ...input, events: [{ ...input.events[0]!, text: "x".repeat(24_001) }] },
    { ...input, supplied_refs: [{ ...input.supplied_refs[0]!, anchors: [{ ...input.supplied_refs[0]!.anchors[0]!, end_utf16: 99 }] }] },
    { ...input, predicates: [{ ...input.predicates[0]!, object_kinds: ["vocabulary", "vocabulary"] }] },
  ];
  for (const invalid of cases) {
    const { port, llm } = producer(() => JSON.stringify(response));
    await expect(port.produce(invalid as ProduceInputV2)).rejects.toThrow("produce input");
    expect(llm.requests).toHaveLength(0);
  }
});

test("v2 uses the planned fenced prompt and rejects an oversize prompt with zero calls", async () => {
  const { port, llm } = producer(request => {
    expect(request.messages[0]!.content).toContain("A mention has exactly");
    expect(request.messages[0]!.content).toContain("valid_from");
    expect(request.messages[1]!.content).toContain("<<<KZ-QUOTE");
    return JSON.stringify(response);
  });
  expect((await port.produce(input)).status).toBe("ok");
  expect(llm.requests).toHaveLength(1);
  for (const budget of [{ ...input.budget, max_input_tokens: 1 }, { ...input.budget, max_calls: 0 }, { ...input.budget, max_output_tokens: 0 }]) {
    const rejected = await port.produce({ ...input, budget });
    expect(rejected).toMatchObject({ status: "rejected", reason: "budget_exhausted", usage: { calls: 0 } });
  }
  expect(llm.requests).toHaveLength(1);
});

test("v2 rejects provider fence and response-schema attacks after one accountable call", async () => {
  for (const wire of [
    `{"schema":"${EXTRACT_RESPONSE_V2_SCHEMA}","mentions":[],"claims":[],"leak":"<<<KZ-QUOTE"}`,
    JSON.stringify({ ...response, extra: true }),
  ]) {
    const { port, llm } = producer(() => wire);
    expect((await port.produce(input)).status).toBe("rejected");
    expect(llm.requests).toHaveLength(1);
  }
});

test("the real registered world vocabulary passes both model input and response boundaries", async () => {
  const worldInput: ProduceInputV2 = {
    ...input,
    supplied_refs: [],
    vocabulary_refs: [...new Set(WORLD_VOCABULARY.flatMap(spec => [...(spec.vocabulary_values ?? [])]))],
    predicates: WORLD_VOCABULARY.map(spec => ({
      id: spec.predicate,
      object_kinds: [...new Set(spec.objects.map(kind => kind === "literal" || kind === "vocabulary" ? kind : "subject"))],
    })),
  };
  for (const [predicate, value] of [
    ["world.kind", "world/concept"],
    ["learning.assistance", "learning/assisted"],
    ["learning.assistance", "learning/unassisted"],
  ]) {
    const wire = {
      ...response,
      mentions: [{ ...response.mentions[0]!, candidate_refs: [] }],
      claims: [{ ...response.claims[0]!, predicate, object: { kind: "vocabulary", ref: { kind: "vocabulary", id: value } } }],
    };
    const { port, llm } = producer(() => JSON.stringify(wire));
    expect((await port.produce(worldInput)).status).toBe("ok");
    expect(llm.requests).toHaveLength(1);
  }
  const unknown = { ...response, mentions: [{ ...response.mentions[0]!, candidate_refs: [] }],
    claims: [{ ...response.claims[0]!, predicate: "world.kind", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/unregistered" } } }] };
  expect((await producer(() => JSON.stringify(unknown)).port.produce(worldInput)).status).toBe("rejected");
});
