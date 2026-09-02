import { describe, expect, test } from "bun:test";
import {
  LLM_CONTRACT,
  LLM_CONTRACT_MINOR,
  PRODUCER_CONTRACT_MINOR,
  validatePortDescriptor,
} from "../../src/index";
import type {
  LlmPort,
  LlmResponse,
  PortDescriptor,
  PortHealth,
  ProduceResult,
} from "../../src/index";

const MINOR_ZERO: PortDescriptor = validatePortDescriptor({
  id: "kizuki.llm.minor-zero",
  kind: "llm",
  contract: LLM_CONTRACT,
  contract_minor: 0,
  supports: ["chat"],
  requires_lease: false,
  optional_package: null,
});

/**
 * An implementation written before the additive fields existed. RFC 0002 §3.3
 * makes an additive minor a promise a caller checks, not a break, so this file
 * fails to compile the moment a field documented `contract_minor >= 1` is
 * required of every implementation.
 */
class MinorZeroLlm implements LlmPort {
  readonly descriptor = MINOR_ZERO;
  readonly model_ref = "kizuki.llm.minor-zero:m@localhost";

  async complete(): Promise<LlmResponse> {
    return {
      text: '{"claims":[]}',
      model: "m",
      usage: { input_tokens: 4, output_tokens: 2 },
    };
  }

  async health(): Promise<PortHealth> {
    return { status: "ready", detail: {} };
  }

  async close(): Promise<void> {}
}

describe("additive contract minors", () => {
  test("a model port written to minor 0 still satisfies kizuki.llm/v1", async () => {
    const port: LlmPort = new MinorZeroLlm();
    const answer = await port.complete({
      messages: [{ role: "user", content: "hi" }],
      max_output_tokens: 16,
      deadline_ms: 1_000,
    });
    expect("attempts" in answer).toBe(false);
    expect(port.descriptor.contract_minor).toBeLessThan(LLM_CONTRACT_MINOR);
  });

  test("a result written to minor 0 still satisfies kizuki.producer/v1", () => {
    const result: ProduceResult = {
      status: "ok",
      claims: [],
      usage: { calls: 1, input_tokens: 4, output_tokens: 2 },
    };
    expect(result).not.toHaveProperty("covered_event_ids");
    expect(result).not.toHaveProperty("dropped_predicates");
    expect(PRODUCER_CONTRACT_MINOR).toBeGreaterThan(0);
  });
});
