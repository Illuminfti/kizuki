import { modelQuoteWire } from "./quote-wire-helper";
import { afterEach, expect, test } from "bun:test";
import { EXTRACT_RESPONSE_V2_SCHEMA, type ProduceInputV2 } from "../../src/contracts/producer-v2";
import { EXTRACTION_V2_SYSTEM_PROMPT, extractionV2SystemContent } from "../../src/producer/prompt-v2";
import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR } from "../../src/producer/model-v2";
import { validateProduceResult } from "../../src/producer/result";
import { temporaryProducerContext, scriptedLlm } from "./helpers";
import { worldProduceInput } from "../../src/serve/extract-v2";
import { WORLD_VOCABULARY } from "../../src/contracts/world-vocabulary";
import type { SystemOnePort, SystemOneRequest, SystemOneResponse } from "../../src/contracts/systemone";
import { PortError, validatePortDescriptor, type PortHealth } from "../../src/contracts/ports";
import { PortRegistry, MODEL_PRODUCER_V2_ID, PRODUCER_V2_CONTRACT, registerModelProducerV2Port, type ProducerV2Port } from "../../src";

const input: ProduceInputV2 = {
  events: [{ event_id: "00000000000000000000000001", text: "Mira joined Northwind." }],
  supplied_refs: [{ id: "s0", anchors: [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }] }],
  vocabulary_refs: ["v-person"], predicates: [{ id: "classification.instance_of", object_kinds: ["vocabulary"] }],
  budget: { max_calls: 1, max_input_tokens: 20_000, max_output_tokens: 2_000 },
};
const response = { schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [{ id: "m0", label: "Mira", anchor: { event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }, candidate_refs: [{ kind: "supplied", id: "s0" }] }], claims: [{ id: "c0", subject: { kind: "mention", id: "m0" }, predicate: "classification.instance_of", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "v-person" } }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [], polarity: "positive", body: "Mira is a person.", valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "personal", anchors: [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }] }] };
const cleanups: (() => void)[] = []; afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function producer(script: Parameters<typeof scriptedLlm>[0]) { const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR); cleanups.push(temp.cleanup); const llm = scriptedLlm(request => { const result = script(request); try { return JSON.stringify(modelQuoteWire(JSON.parse(result), input.events)); } catch { return result; } }); return { port: createModelProducerV2Port(temp.ctx, { llm }), llm }; }

function judgedProducer(evaluate: (request: SystemOneRequest) => Promise<SystemOneResponse>, model_ref: string | null = "test-judge", health: () => Promise<PortHealth> = async () => ({ status: "ready", detail: {} })) {
  const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR);
  cleanups.push(temp.cleanup);
  const judge: SystemOnePort = {
    descriptor: validatePortDescriptor({ id: "test.systemone.v2", kind: "systemone", contract: "kizuki.systemone/v1", contract_minor: 0, supports: ["evaluate"], requires_lease: false, optional_package: null }),
    model_ref, evaluate, health, async close() {},
  };
  const llm = scriptedLlm(() => JSON.stringify(modelQuoteWire(response, input.events)));
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

test("v2 judge health never relays provider diagnostics or thrown details", async () => {
  for (const health of [
    async (): Promise<PortHealth> => ({ status: "unavailable", reason: "private provider details" }),
    async (): Promise<PortHealth> => ({ status: "degraded", degraded: ["private provider details"], detail: { secret: "private" } }),
    async (): Promise<PortHealth> => { throw new Error("private provider details"); },
  ]) {
    const port = judgedProducer(async () => { throw new Error("must not evaluate"); }, "test-judge", health);
    expect(await port.health()).toEqual({ status: "unavailable", reason: "configured systemone is unavailable" });
  }
  const port = judgedProducer(async () => { throw new Error("must not evaluate"); }, "test-judge", async () => ({ status: "ready", detail: { secret: "private" } }));
  expect(await port.health()).toEqual({ status: "ready", detail: {} });
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
  const { port, llm } = producer(request => {
    expect(request.messages[0]!.content).toContain("copy object.value verbatim from one contiguous source passage within a cited anchor span");
    expect(request.messages[0]!.content).toContain("preserving determiners, modality and negation");
    expect(request.messages[0]!.content).toContain("The body may faithfully render the same proposition without adding meaning");
    const prompt = request.messages[1]!.content;
    expect(prompt).toContain("<<<KZ-QUOTE"); expect(prompt).toContain("Mira joined Northwind.");
    return JSON.stringify(response);
  });
  const result = await port.produce(input);
  expect(result).toMatchObject({ status: "ok", response: { claims: [{ subject: { kind: "mention", id: "m0" } }] }, usage: { calls: 1 } });
  expect(llm.requests).toHaveLength(1);
});

test("typed producer binds through the public registry and releases its own capability", async () => {
  const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR); cleanups.push(temp.cleanup);
  const registry = new PortRegistry(), llm = scriptedLlm(() => JSON.stringify(modelQuoteWire(response, input.events)));
  registerModelProducerV2Port(() => llm, registry);
  await expect(registry.bindFromConfig<ProducerV2Port>("producer", { producer: MODEL_PRODUCER_V2_ID }, temp.ctx)).rejects.toThrow("contract");
  const bound = await registry.bindFromConfig<ProducerV2Port>("producer", { producer: MODEL_PRODUCER_V2_ID }, temp.ctx, PRODUCER_V2_CONTRACT);
  expect(bound.d.contract).toBe("kizuki.producer/v2");
  expect((await bound.port.produce(input)).status).toBe("ok");
  await bound.port.close();
  await expect(bound.port.produce(input)).rejects.toThrow("closed");
  expect((await llm.health()).status).toBe("ready");
});

test("v2 rejects injected fence leaks and unmatched quotes, and never admits an invalid reference", async () => {
  const { port } = producer(() => `{"schema":"${EXTRACT_RESPONSE_V2_SCHEMA}","mentions":[],"claims":[],"x":"<<<KZ-QUOTE"}`);
  expect((await port.produce(input)).status).toBe("rejected");
  const unanchored = JSON.stringify({ ...response, mentions: [{ ...response.mentions[0], anchor: { event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 99 } }] });
  expect(await producer(() => unanchored).port.produce(input)).toMatchObject({ status: "rejected", reason: "schema_invalid", usage: { calls: 1 } });
  const forged = JSON.stringify({ ...response, claims: [{ ...response.claims[0], subject: { kind: "supplied", id: "durable-id" } }] });
  const result = await producer(() => forged).port.produce(input);
  expect(result).toMatchObject({ status: "ok", response: { claims: [] }, dropped: [{ reason: "invalid_claim", id: "c0" }] });
  expect(JSON.stringify(result)).not.toContain("durable-id");
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
  expect(await producer(() => JSON.stringify(unknown)).port.produce(worldInput)).toMatchObject({ status: "ok", response: { claims: [] }, dropped: [{ reason: "invalid_claim", id: "c0" }] });
});

test("the extraction prompt teaches how admitted claims become discoverable Concepts and Situations", () => {
  for (const term of ["world.kind", "world/concept", "world/situation", "concept.label", "situation.label", "concept.definition", "situation.objective"]) {
    expect(extractionV2SystemContent(worldProduceInput(input.events as never))).toContain(term);
  }
  expect(EXTRACTION_V2_SYSTEM_PROMPT).not.toContain('"id":"handle"');
});

test("the extraction prompt separates evidenced classification from attributed details without promoting reports", () => {
  const prompt = extractionV2SystemContent(worldProduceInput(input.events as never));
  for (const rule of [
    "Choose perspective separately for each claim's proposition",
    "Quoted input packaging alone does not make every proposition quoted or reported",
    "positive/asserted world.kind",
    "null holder, speaker and addressee",
    "If the classification itself is uncertain or only attributed, preserve that mode",
    "Assert a label only when adopting an exact source-grounded name",
    "never assert a kind or label merely for discoverability",
    "Return empty arrays when no grounded claim exists",
    "Quoted or reported evidence does not become an asserted owner fact",
  ]) expect(prompt).toContain(rule);
});

test("the extraction prompt keeps identity candidates and attribution roles tied to their actual referents", () => {
  const prompt = extractionV2SystemContent(worldProduceInput(input.events as never));
  for (const rule of [
    "Add a candidate only when the mention and candidate are the same referent and the quoted source explicitly supports that identity. Attribution, provenance, authorship, containment, topic, or other association never makes a source or document handle a candidate for the mentioned object.",
    "Judge kind and label separately from each detail and from each other. A directly evidenced kind may be asserted even when the name or details are attributed.",
    "Assert a label only when the evidence presents that name directly as the subject's adopted name; if a speaker, holder, document, or historical source is the one said to use the name, preserve the label's attribution and valid time.",
    "Treat a document, log, transcript, note, or record as a holder or source of an attributed proposition, never as the person speaker. Use an existing supplied ref for an attribution role only when the quoted source shows that it identifies the same attribution referent. When an attribution referent is evidenced but no supplied ref identifies it, use a distinct mention anchored to the actual speaker or holder.",
  ]) expect(prompt).toContain(rule);
});

test("quote resolution receipts bind scrubbed coordinates before ordinary restoration", async () => {
  const { planModelExtractionV2 } = await import("../../src/producer/model-v2");
  const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR); cleanups.push(temp.cleanup);
  const text = `Bearer ${"x".repeat(40)} Mira joined Northwind.`;
  const start = text.indexOf("Mira");
  const originalAnchor = { event_id: input.events[0]!.event_id, start_utf16: start, end_utf16: start + 4 };
  const changedInput = { ...input, events: [{ event_id: originalAnchor.event_id, text }], supplied_refs: [{ id: "s0", anchors: [originalAnchor] }] };
  const plan = planModelExtractionV2(changedInput);
  if (plan.status !== "ready") throw new Error("planning failed");
  const outboundAnchor = plan.outbound.supplied_refs[0]!.anchors[0]!;
  const publicFixture = { ...response, mentions: [{ ...response.mentions[0]!, anchor: outboundAnchor }], claims: [{ ...response.claims[0]!, anchors: [outboundAnchor] }] };
  const receipts: unknown[] = [];
  const llm = scriptedLlm(() => JSON.stringify(modelQuoteWire(publicFixture, plan.outbound.events)));
  const port = createModelProducerV2Port(temp.ctx, { llm, onWireReceipt: receipt => receipts.push(receipt) });
  const result = await port.produce(changedInput);
  expect(result).toMatchObject({ status: "ok", response: { mentions: [{ anchor: originalAnchor }], claims: [{ anchors: [originalAnchor] }] } });
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ resolutions: [{ anchor: outboundAnchor }, { anchor: outboundAnchor }] });
  expect(outboundAnchor.start_utf16).not.toBe(start);
  expect(llm.requests).toHaveLength(1);
});

test("quote spans preserve exact supplied grounding and fail once without receipts on ambiguity", async () => {
  const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR); cleanups.push(temp.cleanup);
  let receiptCount = 0;
  const fixture = { ...response, mentions: [], claims: [{ ...response.claims[0]!, subject: { kind: "supplied", id: "s0" }, anchors: [{ event_id: input.events[0]!.event_id, start_utf16: 0, end_utf16: input.events[0]!.text.length }] }] };
  const llm = scriptedLlm(() => JSON.stringify(modelQuoteWire(fixture, input.events)));
  const port = createModelProducerV2Port(temp.ctx, { llm, onWireReceipt: () => receiptCount++ });
  expect(await port.produce(input)).toMatchObject({ status: "ok", response: { claims: [] }, dropped: [{ id: "c0", reason: "invalid_claim" }] });
  expect(receiptCount).toBe(1); // Conversion is separate from unchanged strict grounding.
  const bad = scriptedLlm(() => JSON.stringify({ schema: "kizuki.model-extraction/quote-anchors-v1", mentions: [{ id: "m", label: "Mira", candidate_refs: [], anchor: { event_id: input.events[0]!.event_id, quote: "Mira" } }], claims: [] }));
  const rejected = createModelProducerV2Port(temp.ctx, { llm: bad, onWireReceipt: () => receiptCount++ });
  expect(await rejected.produce({ ...input, events: [{ ...input.events[0]!, text: "Mira Mira" }] })).toMatchObject({ status: "rejected", reason: "schema_invalid", usage: { calls: 1 } });
  expect(receiptCount).toBe(1);
  expect(bad.requests).toHaveLength(1);
});
