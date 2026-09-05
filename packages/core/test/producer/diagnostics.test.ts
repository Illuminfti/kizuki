import { describe, expect, test } from "bun:test";
import { PortError } from "../../src/contracts/ports";
import { createModelProducerPort, MODEL_PRODUCER_DESCRIPTOR } from "../../src/producer/model";
import { parseExtractResponse } from "../../src/producer/schema";
import { draft, GRACE_EVENT, input, responseText, scriptedLlm, temporaryProducerContext } from "./helpers";

const CANARY = "synthetic-private-diagnostic-canary";

describe("content-free producer diagnostics", () => {
  test("schema failures distinguish field, rule, shape and original claim count", () => {
    const missing = { ...draft() } as Record<string, unknown>;
    delete missing.sensitivity;
    const cases = [
      { value: draft({ predicate: { secret: CANARY } as never }), field: "predicate", rule: "bounded_string", shape: "object" },
      { value: missing, field: "sensitivity", rule: "missing_field", shape: "undefined" },
      { value: { ...draft(), [CANARY]: CANARY }, field: "claim", rule: "extra_field", shape: "object" },
    ] as const;
    for (const entry of cases) {
      const parsed = parseExtractResponse(responseText([draft(), entry.value]));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.diagnostic).toEqual({ stage: "claims", rule: entry.rule, field: entry.field, shape: entry.shape, claim_index: 1, claim_count: 2 });
      expect(JSON.stringify(parsed)).not.toContain(CANARY);
    }
  });

  test("response rejection and transport failure have different fixed classes", async () => {
    for (const [error, status, diagnostic] of [
      [new PortError("unavailable", "rejected: unsupported_metadata", false), "rejected", { stage: "response", rule: "unsupported_metadata" }],
      [new PortError("unavailable", "model network", true), "unavailable", { stage: "transport", rule: "network" }],
      [new PortError("unavailable", CANARY, false), "unavailable", { stage: "transport", rule: "unavailable" }],
    ] as const) {
      const temporary = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR);
      const llm = scriptedLlm(() => error);
      const producer = createModelProducerPort(temporary.ctx, { llm });
      try {
        const result = await producer.produce(input([GRACE_EVENT]));
        expect(result.status).toBe(status);
        expect(result).toMatchObject({ diagnostic, usage: { calls: 1 } });
        expect(JSON.stringify([result, temporary.logs])).not.toContain(CANARY);
        expect(llm.requests).toHaveLength(1);
      } finally { await producer.close(); temporary.cleanup(); }
    }
  });

  test("schema detail survives the producer and unknown predicates never enter logs", async () => {
    for (const value of [draft({ predicate: 12 as never }), draft({ predicate: CANARY })]) {
      const temporary = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR);
      const producer = createModelProducerPort(temporary.ctx, { llm: scriptedLlm(() => responseText([value])) });
      try {
        const result = await producer.produce(input([GRACE_EVENT]));
        if (typeof value.predicate === "number") expect(result).toMatchObject({ status: "rejected", diagnostic: { stage: "claims", field: "predicate", claim_count: 1 } });
        else expect(result).toMatchObject({ status: "ok", claims: [], dropped: [{ reason: "unknown_predicate" }] });
        expect(JSON.stringify(temporary.logs)).not.toContain(CANARY);
      } finally { await producer.close(); temporary.cleanup(); }
    }
  });

  // Named budget refusal intent originates in 98a20cd; spending caps are not raised.
  test("budget admission reports the next requested amount before any call", async () => {
    for (const dimension of ["max_calls", "max_input_tokens", "max_output_tokens"] as const) {
      const temporary = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR);
      const llm = scriptedLlm(() => responseText([]));
      const producer = createModelProducerPort(temporary.ctx, { llm });
      const request = input([GRACE_EVENT]);
      try {
        const result = await producer.produce({ ...request, budget: { ...request.budget, [dimension]: 0 } });
        if (result.status === "rejected" && result.diagnostic?.stage === "budget") expect(result.diagnostic.requested).toBeGreaterThan(0);
        expect(result).toMatchObject({ status: "rejected", reason: "budget_exhausted", diagnostic: { stage: "budget", rule: dimension, used: 0, requested: expect.any(Number), limit: 0 } });
        expect(llm.requests).toHaveLength(0);
      } finally { await producer.close(); temporary.cleanup(); }
    }
  });
});
