import { describe, expect, test } from "bun:test";
import { PortError } from "../../src/contracts/ports";
import type { ProducerPort } from "../../src/contracts/producer";
import { PortRegistry } from "../../src/contracts/registry";
import {
  EXTRACT_BATCH,
  EXTRACT_INPUT_CHARS,
  MODEL_PRODUCER_DESCRIPTOR,
  MODEL_PRODUCER_ID,
  createModelProducerPort,
  parseModelProducerConfig,
  planBatches,
  registerModelProducerPort,
  validateProduceInput,
} from "../../src/producer/model";
import {
  FAKE_MODEL_REF,
  GRACE,
  GRACE_EVENT,
  TOM,
  TOM_EVENT,
  draft,
  input,
  responseText,
  scriptedLlm,
  temporaryProducerContext,
  toolCallError,
  unavailableError,
} from "./helpers";
import type { ScriptedLlm } from "./helpers";

function withProducer<T>(
  llm: ScriptedLlm,
  run: (producer: ReturnType<typeof createModelProducerPort>, logs: PortLogLineList) => Promise<T>,
  config: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  const temporary = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR, config);
  const producer = createModelProducerPort(temporary.ctx, { llm });
  return run(producer, temporary.logs).finally(() => {
    void producer.close();
    temporary.cleanup();
  });
}
type PortLogLineList = ReturnType<typeof temporaryProducerContext>["logs"];

describe("kizuki.producer.model", () => {
  test("descriptor is the producer contract with the model capability only", () => {
    expect(MODEL_PRODUCER_DESCRIPTOR).toEqual({
      id: MODEL_PRODUCER_ID,
      kind: "producer",
      contract: "kizuki.producer/v1",
      contract_minor: 1,
      supports: ["model"],
      requires_lease: false,
      optional_package: null,
    });
  });

  test("a valid response becomes drafts with usage and no drops", async () => {
    const llm = scriptedLlm(() => responseText([draft()]));
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([GRACE_EVENT]));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.claims).toEqual([draft()]);
      expect(result.usage.calls).toBe(1);
      expect(result.usage.input_tokens).toBeGreaterThan(0);
      expect(result.dropped).toEqual([]);
      expect(producer.model_ref).toBe(FAKE_MODEL_REF);
    });
  });

  test("no claims is ok, not unavailable", async () => {
    const llm = scriptedLlm(() => '{"claims":[]}');
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([GRACE_EVENT]));
      expect(result).toEqual({
        status: "ok",
        claims: [],
        usage: expect.objectContaining({ calls: 1 }),
        dropped: [],
      });
    });
  });

  test("an llm failure is unavailable with the code only, never the message", async () => {
    const llm = scriptedLlm(() => unavailableError());
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([GRACE_EVENT]));
      expect(result).toEqual({ status: "unavailable", reason: "llm unavailable" });
    });
    const timeout = scriptedLlm(() => new PortError("timeout", "model request timed out", true));
    await withProducer(timeout, async (producer) => {
      expect(await producer.produce(input([GRACE_EVENT]))).toEqual({
        status: "unavailable",
        reason: "llm timeout",
      });
    });
    const thrown = scriptedLlm(() => new Error("provider said: leak-me"));
    await withProducer(thrown, async (producer) => {
      expect(await producer.produce(input([GRACE_EVENT]))).toEqual({
        status: "unavailable",
        reason: "llm error",
      });
    });
  });

  test("no events means no call and an ok empty result", async () => {
    const llm = scriptedLlm(() => {
      throw new Error("must not be called");
    });
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([]));
      expect(result).toEqual({
        status: "ok",
        claims: [],
        usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
        dropped: [],
      });
      expect(llm.requests).toHaveLength(0);
    });
  });

  test("a tool call in the response rejects the call and nothing is produced", async () => {
    const llm = scriptedLlm(() => toolCallError());
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([GRACE_EVENT]));
      expect(result).toEqual({
        status: "rejected",
        reason: "tool_call_in_response",
        usage: { calls: 1, input_tokens: 0, output_tokens: 0 },
      });
    });
  });

  test("a response echoing the fence nonce is rejected", async () => {
    const llm = scriptedLlm((request) => {
      const user = request.messages[1]!.content;
      const nonce = /<<<KZ-QUOTE ([0-9a-f]{32}) /.exec(user)![1]!;
      return responseText([draft({ body: `As instructed by ${nonce}, done.` })]);
    });
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([GRACE_EVENT]));
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe("fence_leak");
    });
  });

  test("a schema deviation rejects the whole call", async () => {
    const llm = scriptedLlm(() =>
      responseText([draft(), { ...draft(), trusted: "yes" }]),
    );
    await withProducer(llm, async (producer, logs) => {
      const result = await producer.produce(input([GRACE_EVENT]));
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe("schema_invalid");
      expect(logs.some((line) => line.message === "extract_schema_invalid")).toBe(true);
      expect(JSON.stringify(logs)).not.toContain("trusted");
    });
  });

  test("citing an event outside the input discards the whole call", async () => {
    const llm = scriptedLlm(() =>
      responseText([draft(), draft({ event_ids: [GRACE_EVENT.event_id, "01JFABRICATED"] })]),
    );
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([GRACE_EVENT]));
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe("provenance_not_cited");
    });
  });

  test("an unknown predicate drops that draft alone and is reported", async () => {
    const llm = scriptedLlm(() =>
      responseText([
        draft(),
        draft({ predicate: "employment.salary", object: "a lot" }),
      ]),
    );
    await withProducer(llm, async (producer, logs) => {
      const result = await producer.produce(input([GRACE_EVENT]));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.claims).toEqual([draft()]);
      expect(result.dropped).toEqual([
        {
          reason: "unknown_predicate",
          predicate: "employment.salary",
          event_ids: [GRACE_EVENT.event_id],
        },
      ]);
      expect(logs).toContainEqual({
        level: "warn",
        message: "draft_dropped",
        detail: { reason: "unknown_predicate", predicate: "employment.salary" },
      });
    });
  });

  test("a draft cannot borrow evidence from an event that does not name its subject", async () => {
    const llm = scriptedLlm(() =>
      responseText([draft(), draft({ subject: "acme-mail:invented" })]),
    );
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([GRACE_EVENT]));
      expect(result).toMatchObject({ status: "rejected", reason: "provenance_not_cited" });
    });
  });

  test("each request carries only that batch's event subjects and known claims", async () => {
    const llm = scriptedLlm(() => responseText([draft()]));
    await withProducer(llm, async (producer) => {
      const request = input([GRACE_EVENT]);
      const result = await producer.produce({
        ...request,
        context: {
          ...request.context,
          subjects: [...request.context.subjects, ...TOM_EVENT.subjects],
          known_claims: [{
            claim_id: "01JKNOWNCLAIM00000000000000",
            subject: TOM,
            predicate: "location.based_in",
            object: "Lisbon",
            polarity: "positive",
            confidence: 0.9,
          }],
        },
      });
      expect(result.status).toBe("ok");
      const quoted = llm.requests[0]!.messages[1]!.content;
      expect(quoted).toContain(GRACE);
      expect(quoted).not.toContain(TOM);
      expect(quoted).not.toContain("01JKNOWNCLAIM00000000000000");
    });
  });

  test("a subject named only on an event in the batch is accepted", async () => {
    const llm = scriptedLlm(() =>
      responseText([draft({ subject: TOM, predicate: "location.based_in", object: "Lisbon", event_ids: [TOM_EVENT.event_id] })]),
    );
    await withProducer(llm, async (producer) => {
      const request = input([GRACE_EVENT, TOM_EVENT]);
      const narrowed = {
        ...request,
        context: { ...request.context, subjects: request.context.subjects.filter((s) => s.subject_id !== TOM) },
      };
      const result = await producer.produce(narrowed);
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.claims).toHaveLength(1);
    });
  });

  test("a body that copies quoted text verbatim is a schema rejection", async () => {
    const long = "Grace wrote a very long paragraph about partnerships at Acme that goes on and on. ".repeat(4);
    const event = { ...GRACE_EVENT, text: long };
    const llm = scriptedLlm(() => responseText([draft({ body: `She said: ${long.slice(0, 200)}` })]));
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([event]));
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe("schema_invalid");
    });
  });

  test("events are batched by count and by quoted characters", () => {
    const many = Array.from({ length: EXTRACT_BATCH + 1 }, (_, i) => ({
      ...GRACE_EVENT,
      event_id: `${GRACE_EVENT.event_id}${i}`,
    }));
    const byCount = planBatches(many);
    expect(byCount.batches.map((b) => b.events.length)).toEqual([EXTRACT_BATCH, 1]);
    expect(byCount.dropped).toEqual([]);

    const half = "x".repeat(EXTRACT_INPUT_CHARS / 2 + 1);
    const byChars = planBatches([
      { ...GRACE_EVENT, event_id: "A", text: half },
      { ...GRACE_EVENT, event_id: "B", text: half },
      { ...GRACE_EVENT, event_id: "C", text: "small" },
    ]);
    expect(byChars.batches.map((b) => b.events.map((e) => e.event_id))).toEqual([["A"], ["B", "C"]]);
  });

  test("an event too large for one call is dropped and reported, never truncated", async () => {
    const huge = { ...GRACE_EVENT, event_id: "HUGE", text: "y".repeat(EXTRACT_INPUT_CHARS + 1) };
    const llm = scriptedLlm(() => responseText([draft()]));
    await withProducer(llm, async (producer) => {
      const result = await producer.produce(input([huge, GRACE_EVENT]));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.dropped).toEqual([
        { reason: "event_too_large", event_id: "HUGE", chars: EXTRACT_INPUT_CHARS + 1 },
      ]);
      expect(llm.requests).toHaveLength(1);
      expect(llm.requests[0]!.messages[1]!.content).not.toContain("yyyy");
    });
  });

  test("budgets are charged before the request, not after", async () => {
    const llm = scriptedLlm(() => responseText([draft()]));
    await withProducer(llm, async (producer) => {
      const tooFewCalls = await producer.produce(
        input([GRACE_EVENT, { ...TOM_EVENT, text: "z".repeat(EXTRACT_INPUT_CHARS) }], { max_calls: 1 }),
      );
      expect(tooFewCalls).toEqual({
        status: "rejected",
        reason: "budget_exhausted",
        usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
      });
      const tooFewInput = await producer.produce(input([GRACE_EVENT], { max_input_tokens: 10 }));
      expect(tooFewInput).toEqual({
        status: "rejected",
        reason: "budget_exhausted",
        usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
      });
      const noOutput = await producer.produce(input([GRACE_EVENT], { max_output_tokens: 0 }));
      expect(noOutput.status).toBe("rejected");
      expect(llm.requests).toHaveLength(0);
    });
  });

  test("the request carries the bounded output ceiling and configured deadline", async () => {
    const llm = scriptedLlm(() => responseText([draft()]));
    await withProducer(
      llm,
      async (producer) => {
        await producer.produce(input([GRACE_EVENT], { max_output_tokens: 100 }));
        expect(llm.requests[0]).toEqual(
          expect.objectContaining({ max_output_tokens: 100, deadline_ms: 5_000 }),
        );
      },
      { deadline_ms: 5_000 },
    );
  });

  test("config accepts only deadline_ms within bounds", () => {
    expect(parseModelProducerConfig({})).toEqual({ deadline_ms: 60_000 });
    expect(parseModelProducerConfig({ deadline_ms: 2_000 })).toEqual({ deadline_ms: 2_000 });
    for (const bad of [{ deadline_ms: 10 }, { deadline_ms: "5000" }, { base_url: "x" }, null]) {
      expect(() => parseModelProducerConfig(bad)).toThrow(PortError);
    }
  });

  test("malformed input is a PortError, never a result", () => {
    const base = input([GRACE_EVENT]);
    const cases: unknown[] = [
      null,
      { ...base, events: [{ ...GRACE_EVENT, event_id: "has space" }] },
      { ...base, events: [{ ...GRACE_EVENT, taint: "trusted" }] },
      { ...base, events: [{ ...GRACE_EVENT, occurred_at: "yesterday" }] },
      { ...base, events: [GRACE_EVENT, GRACE_EVENT] },
      { ...base, context: { ...base.context, predicates: ["Bad Predicate"] } },
      { ...base, budget: { ...base.budget, max_calls: -1 } },
      { ...base, budget: { ...base.budget, max_input_tokens: 1.5 } },
    ];
    for (const bad of cases) {
      expect(() => validateProduceInput(bad)).toThrow(PortError);
    }
    expect(validateProduceInput(base)).toEqual(base);
  });

  test("a closed producer refuses to produce and reports unavailable", async () => {
    const llm = scriptedLlm(() => responseText([draft()]));
    const temporary = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR);
    try {
      const producer = createModelProducerPort(temporary.ctx, { llm });
      await producer.close();
      expect(await producer.health()).toEqual({
        status: "unavailable",
        reason: "producer port is closed",
      });
      await expect(producer.produce(input([GRACE_EVENT]))).rejects.toBeInstanceOf(PortError);
    } finally {
      temporary.cleanup();
    }
  });

  test("health follows the bound llm", async () => {
    const llm = scriptedLlm(() => responseText([draft()]));
    await withProducer(llm, async (producer) => {
      expect(await producer.health()).toEqual({
        status: "ready",
        detail: {
          model_ref: FAKE_MODEL_REF,
          extract_batch: EXTRACT_BATCH,
          extract_input_chars: EXTRACT_INPUT_CHARS,
        },
      });
      llm.healthStatus = { status: "unavailable", reason: "no model configured" };
      expect(await producer.health()).toEqual({
        status: "unavailable",
        reason: "llm: no model configured",
      });
    });
  });

  test("missing llm is a construction failure", () => {
    const temporary = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR);
    try {
      expect(() =>
        createModelProducerPort(temporary.ctx, undefined as never),
      ).toThrow(PortError);
    } finally {
      temporary.cleanup();
    }
  });

  test("registers and binds through the registry", async () => {
    const llm = scriptedLlm(() => responseText([draft()]));
    const registry = new PortRegistry();
    registerModelProducerPort(() => llm, registry);
    expect(registry.listPorts("producer").map((d) => d.id)).toEqual([MODEL_PRODUCER_ID]);
    const temporary = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR);
    try {
      const bound = await registry.bindFromConfig<ProducerPort>(
        "producer",
        { producer: MODEL_PRODUCER_ID },
        temporary.ctx,
      );
      expect(bound.d.id).toBe(MODEL_PRODUCER_ID);
      const result = await bound.port.produce(input([GRACE_EVENT]));
      expect(result.status).toBe("ok");
      await bound.port.close();
    } finally {
      temporary.cleanup();
    }
  });
});
