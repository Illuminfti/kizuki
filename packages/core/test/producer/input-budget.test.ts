import { afterEach, expect, test } from "bun:test";
import { llmInputTokenOverhead, type LlmPort } from "../../src/contracts/llm";
import { PortError } from "../../src/contracts/ports";
import type { ProduceInputV2 } from "../../src/contracts/producer-v2";
import { inheritModelProducerIdentity, modelProducerInputTokenOverhead } from "../../src/producer/fingerprint";
import { createModelProducerPort, MODEL_PRODUCER_DESCRIPTOR, planModelExtraction } from "../../src/producer/model";
import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR, planModelExtractionV2 } from "../../src/producer/model-v2";
import { GRACE_EVENT, input, scriptedLlm, temporaryProducerContext } from "./helpers";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
const v2: ProduceInputV2 = {
  events: [{ event_id: "00000000000000000000000001", text: "The synthetic library is open." }],
  supplied_refs: [], vocabulary_refs: [], predicates: [],
  budget: { max_calls: 1, max_input_tokens: 32_000, max_output_tokens: 2_000 },
};
function fixture(overhead = 0, usage = { input_tokens: 10, output_tokens: 10 }, legacy = false) {
  const temp = temporaryProducerContext(legacy ? MODEL_PRODUCER_DESCRIPTOR : MODEL_PRODUCER_V2_DESCRIPTOR);
  cleanups.push(temp.cleanup);
  let calls = 0, wire = 0, judge = 0;
  const scripted = scriptedLlm(() => "unused");
  const llm: LlmPort = { ...scripted, input_token_overhead: overhead, async complete() {
    calls++;
    return { text: legacy ? '{"claims":[]}' : '{"schema":"kizuki.model-extraction/quote-anchors-v1","mentions":[],"claims":[]}', model: "synthetic", usage };
  } };
  const judgePort = {
    descriptor: { id: "synthetic.judge", kind: "systemone" as const, contract: "kizuki.systemone/v1", contract_minor: 0, supports: ["evaluate"], requires_lease: false, optional_package: null },
    model_ref: "synthetic", async health() { return { status: "ready" as const, detail: {} }; }, async close() {},
    async evaluate() { judge++; throw new Error("budget refusal must precede admission"); },
  };
  const port = legacy ? createModelProducerPort(temp.ctx, { llm }) : createModelProducerV2Port(temp.ctx, { llm, systemone: judgePort, onWireReceipt() { wire++; } });
  return { llm, port, counts: () => ({ calls, wire, judge }) };
}

test("LLM minor zero has no reserve; minor one declarations fail closed", () => {
  const { llm } = fixture();
  expect(llmInputTokenOverhead({ ...llm, descriptor: { ...llm.descriptor, contract_minor: 0 } })).toBe(0);
  expect(() => llmInputTokenOverhead({ ...llm, descriptor: { ...llm.descriptor, contract_minor: 0 }, input_token_overhead: 32_000 })).toThrow("requires llm contract minor 1");
  const { input_token_overhead: _absent, ...withoutOverhead } = llm;
  expect(llmInputTokenOverhead(withoutOverhead)).toBe(0);
  for (const value of [-1, 32_001, 1.5, NaN, Infinity, null, "24000"]) {
    expect(() => llmInputTokenOverhead({ ...llm, input_token_overhead: value as number })).toThrow(PortError);
  }
});

test("v2 planner reserves configured overhead exactly once and exposes honest planning totals", () => {
  const base = planModelExtractionV2(v2);
  expect(base.status).toBe("ready");
  if (base.status !== "ready") throw new Error("synthetic plan missing");
  const limit = base.input_tokens + 24_000;
  const planned = planModelExtractionV2({ ...v2, budget: { ...v2.budget, max_input_tokens: limit } }, 24_000);
  expect(planned).toMatchObject({ status: "ready", input_tokens: base.input_tokens, input_token_overhead: 24_000, reserved_input_tokens: limit });
  expect(planModelExtractionV2({ ...v2, budget: { ...v2.budget, max_input_tokens: limit - 1 } }, 24_000)).toMatchObject({ status: "rejected", diagnostic: { requested: limit } });
  for (const invalid of [-1, .5, 32_001]) expect(() => planModelExtractionV2(v2, invalid)).toThrow(PortError);
});

test("built-in metadata survives identity observation and arbitrary producer properties have no authority", async () => {
  const f = fixture(24_000);
  expect(modelProducerInputTokenOverhead(f.port)).toBe(24_000);
  expect(modelProducerInputTokenOverhead({ ...f.port, input_token_overhead: 24_000 })).toBe(0);
  if (f.port.descriptor.contract !== "kizuki.producer/v2") throw new Error("fixture contract");
  const port = f.port as ReturnType<typeof createModelProducerV2Port>;
  const wrapper = inheritModelProducerIdentity(port, { ...port, produce: async value => port.produce(value) });
  expect(modelProducerInputTokenOverhead(wrapper)).toBe(24_000);
  expect(await wrapper.produce({ ...v2, budget: { ...v2.budget, max_input_tokens: 24_000 } })).toMatchObject({ status: "rejected", reason: "budget_exhausted", usage: { calls: 0 } });
  expect(f.counts()).toEqual({ calls: 0, wire: 0, judge: 0 });
});

for (const dimension of ["input_tokens", "output_tokens"] as const) {
  test(`v2 refuses measured excess ${dimension} before wire receipts or admission and keeps full usage`, async () => {
    const usage = { input_tokens: 10, output_tokens: 10, [dimension]: v2.budget[dimension === "input_tokens" ? "max_input_tokens" : "max_output_tokens"] + 1 };
    const f = fixture(0, usage);
    expect(await (f.port as ReturnType<typeof createModelProducerV2Port>).produce(v2)).toMatchObject({ status: "rejected", reason: "budget_exhausted", usage: { calls: 1, ...usage } });
    expect(f.counts()).toEqual({ calls: 1, wire: 0, judge: 0 });
  });
  test(`v1 stops before a subsequent call after measured excess ${dimension}`, async () => {
    const events = Array.from({ length: 9 }, (_, i) => ({ ...GRACE_EVENT, event_id: `synthetic-event-${i}` }));
    const request = input(events, { max_calls: 2, max_input_tokens: 32_000, max_output_tokens: 10_000 });
    const plan = planModelExtraction(request, 1_000);
    expect(plan.status === "ready" && plan.calls.length).toBe(2);
    const usage = { input_tokens: 10, output_tokens: 10, [dimension]: request.budget[dimension === "input_tokens" ? "max_input_tokens" : "max_output_tokens"] + 1 };
    const f = fixture(1_000, usage, true);
    expect(await (f.port as ReturnType<typeof createModelProducerPort>).produce(request)).toMatchObject({ status: "rejected", reason: "budget_exhausted", usage: { calls: 1, ...usage } });
    expect(f.counts().calls).toBe(1);
  });
}

test("v1 reserves overhead once for each planned call and rejects before transport", async () => {
  const request = input(Array.from({ length: 9 }, (_, i) => ({ ...GRACE_EVENT, event_id: `synthetic-${i}` })), { max_calls: 2, max_input_tokens: 20_000 });
  const f = fixture(12_000, undefined, true);
  expect(planModelExtraction(request).status).toBe("ready");
  expect(planModelExtraction(request, 12_000).status).toBe("rejected");
  expect(await (f.port as ReturnType<typeof createModelProducerPort>).produce(request)).toMatchObject({ status: "rejected", reason: "budget_exhausted", usage: { calls: 0 } });
  expect(f.counts().calls).toBe(0);
});

test("v1 rechecks actual cumulative input before spending the next call's reserved capacity", async () => {
  const request = input(Array.from({ length: 9 }, (_, i) => ({ ...GRACE_EVENT, event_id: `synthetic-next-${i}` })), { max_calls: 2, max_input_tokens: 32_000 });
  const plan = planModelExtraction(request, 1_000);
  if (plan.status !== "ready") throw new Error("synthetic plan unavailable");
  const nextReserve = Math.ceil(plan.calls[1]!.messages.reduce((sum, message) => sum + message.content.length, 0) / 4) + 1_000;
  const observed = request.budget.max_input_tokens - nextReserve + 1;
  expect(observed).toBeLessThan(request.budget.max_input_tokens);
  const f = fixture(1_000, { input_tokens: observed, output_tokens: 1 }, true);
  expect(await (f.port as ReturnType<typeof createModelProducerPort>).produce(request)).toMatchObject({ status: "rejected", reason: "budget_exhausted",
    usage: { calls: 1, input_tokens: observed, output_tokens: 1 }, diagnostic: { rule: "max_input_tokens", used: observed, requested: nextReserve } });
  expect(f.counts().calls).toBe(1);
});

test("a transport-refused response cannot hide measured over-budget usage behind its parse refusal", async () => {
  for (const legacy of [false, true]) {
    const context = temporaryProducerContext(legacy ? MODEL_PRODUCER_DESCRIPTOR : MODEL_PRODUCER_V2_DESCRIPTOR);
    cleanups.push(context.cleanup);
    const usage = { input_tokens: 32_001, output_tokens: 10 };
    const llm = scriptedLlm(() => new PortError("unavailable", "rejected: response_truncated", false, { usage }));
    const result = legacy
      ? await createModelProducerPort(context.ctx, { llm }).produce(input([GRACE_EVENT], { max_input_tokens: 32_000 }))
      : await createModelProducerV2Port(context.ctx, { llm }).produce(v2);
    expect(result).toMatchObject({ status: "rejected", reason: "budget_exhausted", usage: { calls: 1, ...usage } });
    expect(result).not.toHaveProperty("claims");
    expect(result).not.toHaveProperty("response");
  }
});
