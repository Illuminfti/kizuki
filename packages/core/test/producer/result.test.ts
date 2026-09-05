import { describe, expect, test } from "bun:test";
import { validateProduceResult, invokeProducer } from "../../src/producer/result";
import { draft, GRACE_EVENT, input } from "./helpers";
import { MODEL_PRODUCER_DESCRIPTOR } from "../../src/producer/model";
import { EXTRACT_RESPONSE_V2_SCHEMA, PRODUCER_V2_CONTRACT, type ProducerV2ParseInput } from "../../src/contracts/producer-v2";

const CANARY = "synthetic-private-result-canary";
const usage = { calls: 1, input_tokens: 12, output_tokens: 4 };

describe("complete producer result boundary", () => {
  test("valid v1 results retain exact drafts and detached usage", () => {
    const raw = { status: "ok" as const, claims: [draft()], usage: { ...usage } };
    const validated = validateProduceResult(raw);
    expect(validated).toEqual({ result: raw, usage_known: true });
    raw.usage.calls = 9;
    expect(validated.result.usage.calls).toBe(1);
  });

  test("aggregated v1 results retain the original per-response parser rules", () => {
    const validated = validateProduceResult({ status: "ok", claims: Array.from({ length: 65 }, () => draft()), usage });
    expect(validated.usage_known).toBe(true);
    expect(validated.result.status === "ok" && validated.result.claims.length).toBe(65);
  });

  test("v1 string unavailability is wire-compatible but has a fixed safe projection", () => {
    expect(validateProduceResult({ status: "unavailable", reason: CANARY, usage })).toEqual({
      result: { status: "unavailable", reason: "unavailable", usage }, usage_known: true,
    });
  });

  test("all status branches reject extra keys, invalid usage and diagnostic canaries", () => {
    const values: unknown[] = [
      { status: CANARY, usage },
      { status: "rejected", reason: CANARY, usage },
      { status: "rejected", reason: "schema_invalid", usage, diagnostic: { stage: "response", rule: "bad_response", text: CANARY } },
      { status: "unavailable", reason: "unavailable", usage, diagnostic: { stage: "transport", rule: CANARY } },
      { status: "ok", claims: [], usage, diagnostic: { text: CANARY } },
      { status: "ok", claims: [draft({ body: CANARY })], usage, [CANARY]: CANARY },
      { status: "ok", claims: [], usage, dropped: [{ reason: CANARY }] },
      { status: "ok", claims: [], usage, dropped: [{ reason: "unknown_subject", subject: CANARY, event_ids: [GRACE_EVENT.event_id], text: CANARY }] },
    ];
    for (const status of ["ok", "rejected", "unavailable"]) {
      for (const calls of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
        values.push({ status, ...(status === "ok" ? { claims: [] } : { reason: "schema_invalid" }), usage: { ...usage, calls } });
      }
    }
    for (const value of values) {
      const validated = validateProduceResult(value);
      expect(validated).toMatchObject({ usage_known: false, result: { status: "rejected", reason: "schema_invalid", usage: { calls: 1 } } });
      expect(JSON.stringify(validated)).not.toContain(CANARY);
    }
  });

  test("malformed nested values, accessors and excessive lists fail without executing getters", () => {
    let read = false;
    const accessor = { get status() { read = true; throw new Error(CANARY); }, usage };
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    for (const raw of [accessor, { status: "ok", claims: cyclic, usage }, { status: "ok", claims: Array(513).fill(draft()), usage }]) {
      expect(validateProduceResult(raw).usage_known).toBe(false);
    }
    expect(read).toBe(false);
  });

  test("sync throws and rejected promises become fixed unavailable with unknown consumption", async () => {
    for (const produce of [() => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY))]) {
      const result = await invokeProducer({ descriptor: MODEL_PRODUCER_DESCRIPTOR, produce }, input([GRACE_EVENT]));
      expect(result).toMatchObject({ usage_known: false, result: { status: "unavailable", reason: "unavailable", usage: { calls: 1 } } });
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  });
});

describe("producer v2 complete result boundary", () => {
  const context: ProducerV2ParseInput = { events: [{ event_id: "00000000000000000000000001", text: "Mira leads." }], supplied_refs: [], vocabulary_refs: [], predicates: [] };
  const response = { schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [], claims: [] };

  test("v2 success is explicitly dispatched, and both majors reject crossed shapes", () => {
    const raw = { status: "ok" as const, response, usage };
    expect(validateProduceResult(raw, PRODUCER_V2_CONTRACT, context)).toEqual({ usage_known: true, result: raw });
    expect(validateProduceResult(raw).usage_known).toBe(false);
    expect(validateProduceResult({ status: "ok", claims: [], usage }, PRODUCER_V2_CONTRACT, context).usage_known).toBe(false);
  });

  test("all v2 non-success reasons, usage and diagnostics are closed", () => {
    for (const raw of [
      { status: "unavailable", reason: CANARY, usage },
      { status: "rejected", reason: CANARY, usage },
      { status: "rejected", reason: "schema_invalid", usage, diagnostic: { stage: "response", rule: "bad_response", text: CANARY } },
      { status: "unavailable", reason: "network", usage: { ...usage, input_tokens: Infinity } },
      { status: "ok", response, usage, dropped: [{ reason: CANARY, id: "c0" }] },
    ]) {
      const validated = validateProduceResult(raw, PRODUCER_V2_CONTRACT, context);
      expect(validated.usage_known).toBe(false);
      expect(JSON.stringify(validated)).not.toContain(CANARY);
    }
    for (const raw of [
      { status: "unavailable", reason: "network", usage, diagnostic: { stage: "transport", rule: "network" } },
      { status: "rejected", reason: "schema_invalid", usage, diagnostic: { stage: "response", rule: "bad_response" } },
    ] as const) expect(validateProduceResult(raw, PRODUCER_V2_CONTRACT, context)).toEqual({ usage_known: true, result: raw });
  });
});
