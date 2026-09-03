import { describe, expect, test } from "bun:test";
import { runProducerConformance } from "../../src/contracts/conformance/producer";
import type { ProducerConformanceHarness } from "../../src/contracts/conformance/producer";
import {
  MODEL_PRODUCER_DESCRIPTOR,
  createModelProducerPort,
} from "../../src/producer/model";
import {
  GRACE_EVENT,
  draft,
  input,
  responseText,
  scriptedLlm,
} from "./helpers";

function harness(): ProducerConformanceHarness {
  const llm = scriptedLlm(() => responseText([draft()]));
  return {
    descriptor: MODEL_PRODUCER_DESCRIPTOR,
    create: async (ctx) => createModelProducerPort(ctx, { llm }),
    destroy: async (port) => port.close(),
    fixtures: { name: "model" },
    driver: {
      apply: async (port) => port.produce(input([GRACE_EVENT])),
      observe: async (port) => ({
        health: await port.health(),
        result: await port.produce(input([GRACE_EVENT])),
      }),
      induceFailure: async (port) =>
        port.produce({ ...input([GRACE_EVENT]), events: [{ ...GRACE_EVENT, event_id: "" }] }),
      remove: async (port) => port.close(),
      verifyAbsent: async () => ({ found: [] }),
    },
  };
}

describe("producer conformance", () => {
  test("kizuki.producer.model passes the shared suite", async () => {
    const report = await runProducerConformance(harness());
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.families).toEqual({
      identity: "pass",
      isolation: "pass",
      idempotence: "pass",
      failure_shape: "pass",
      restart: "pass",
      deletion: "pass",
    });
  });
});
