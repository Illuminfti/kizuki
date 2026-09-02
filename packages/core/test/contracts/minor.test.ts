import { describe, expect, test } from "bun:test";
import {
  LLM_CONTRACT,
  LLM_CONTRACT_MINOR,
  PRODUCER_CONTRACT,
  PRODUCER_CONTRACT_MINOR,
  PRODUCER_COVERAGE_MINOR,
  coveredEvents,
  validatePortDescriptor,
} from "../../src/index";
import type {
  LlmPort,
  LlmResponse,
  PortDescriptor,
  PortHealth,
  ProduceResult,
  QuotedEvent,
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

function producerAt(minor: number): PortDescriptor {
  return validatePortDescriptor({
    id: "kizuki.producer.fixture",
    kind: "producer",
    contract: PRODUCER_CONTRACT,
    contract_minor: minor,
    supports: ["deterministic"],
    requires_lease: false,
    optional_package: null,
  });
}

function quoted(id: string): QuotedEvent {
  return {
    event_id: id,
    connector_id: "markdown-folder",
    occurred_at: "2026-01-01T00:00:00.000Z",
    observed_at: "2026-01-01T00:00:01.000Z",
    text: "short",
    subjects: [],
    taint: "untrusted",
  };
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

  test("coverage is read against the minor of the producer that answered", () => {
    const submitted = [quoted("ev-0"), quoted("ev-1")];
    const usage = { calls: 1, input_tokens: 4, output_tokens: 2 };
    // A producer with no way to stop part way covers what it was given.
    expect(
      coveredEvents(
        producerAt(0),
        { status: "ok", claims: [], usage },
        submitted,
      ),
    ).toEqual(["ev-0", "ev-1"]);
    // At the coverage minor, `ok` can be a run that stopped at an outage, so
    // a caller switching on the status alone would advance over a record the
    // model never saw. An absent list accounts for nothing, not everything.
    expect(
      coveredEvents(
        producerAt(PRODUCER_COVERAGE_MINOR),
        {
          status: "ok",
          claims: [],
          usage,
          covered_event_ids: ["ev-0"],
          stopped: { status: "unavailable", reason: "offline" },
        },
        submitted,
      ),
    ).toEqual(["ev-0"]);
    expect(
      coveredEvents(
        producerAt(PRODUCER_COVERAGE_MINOR),
        { status: "ok", claims: [], usage },
        submitted,
      ),
    ).toEqual([]);
    // Neither outcome that is not `ok` advances anything.
    expect(
      coveredEvents(
        producerAt(PRODUCER_COVERAGE_MINOR),
        { status: "unavailable", reason: "offline" },
        submitted,
      ),
    ).toEqual([]);
    expect(
      coveredEvents(
        producerAt(PRODUCER_COVERAGE_MINOR),
        { status: "rejected", reason: "fence_leak", usage },
        submitted,
      ),
    ).toEqual([]);
  });
});
