import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { runLlmConformance, runProducerConformance } from "@kizuki/core/contracts";
import type {
  ConformanceFixtures,
  LlmPort,
  LlmRequest,
  PortContext,
  ProduceInput,
  ProducerPort,
} from "@kizuki/core";
import { OPENAI_COMPATIBLE_LLM, OpenAiCompatibleLlm } from "../src/llm-port";
import { MODEL_PRODUCER, ModelProducer } from "../src/producer";
import { chatCompletion, startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import { claimsPayload, event, produceInput, scriptedLlm } from "./helpers";

interface LlmFixtures extends ConformanceFixtures {
  request: LlmRequest;
  broken: LlmRequest;
}

interface ProducerFixtures extends ConformanceFixtures {
  input: ProduceInput;
  broken: ProduceInput;
}

const request: LlmRequest = {
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "user" },
  ],
  max_output_tokens: 64,
  deadline_ms: 5_000,
};

let endpoint: FakeEndpoint;
let dataDir = "";

beforeAll(() => {
  endpoint = startFakeEndpoint(() => ({ body: chatCompletion('{"claims":[]}') }));
});
afterAll(async () => {
  await endpoint.stop();
});

function withEndpointConfig(ctx: PortContext): PortContext {
  dataDir = ctx.data_dir;
  return {
    ...ctx,
    config: Object.freeze({ base_url: `${endpoint.url}/v1`, model: "m" }),
  };
}

/** The port must leave its own directory empty: nothing here is durable. */
function absent(): { found: string[] } {
  return { found: readdirSync(dataDir) };
}

describe("contract conformance", () => {
  test("the model port passes kizuki.llm/v1 conformance", async () => {
    const report = await runLlmConformance<LlmFixtures>({
      descriptor: OPENAI_COMPATIBLE_LLM,
      create: async (ctx) =>
        new OpenAiCompatibleLlm(withEndpointConfig(ctx)) as LlmPort,
      destroy: async (port) => {
        await port.close();
      },
      fixtures: {
        name: "openai-compatible",
        request,
        broken: { ...request, messages: [] },
      },
      driver: {
        apply: async (port, fixtures) => await port.complete(fixtures.request),
        observe: async (port) => ({
          model_ref: port.model_ref,
          health: await port.health(),
        }),
        induceFailure: async (port, fixtures) =>
          await port.complete(fixtures.broken),
        remove: async () => undefined,
        verifyAbsent: async () => absent(),
      },
    });
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
  });

  test("the model producer passes kizuki.producer/v1 conformance", async () => {
    const input = produceInput([event("ev-1", "Ada joined acme.")]);
    const report = await runProducerConformance<ProducerFixtures>({
      descriptor: MODEL_PRODUCER,
      create: async (ctx) => {
        dataDir = ctx.data_dir;
        return new ModelProducer(
          ctx,
          scriptedLlm([claimsPayload()]),
        ) as ProducerPort;
      },
      destroy: async (port) => {
        await port.close();
      },
      fixtures: {
        name: "model",
        input,
        broken: { ...input, events: [{} as never] },
      },
      driver: {
        apply: async (port, fixtures) => await port.produce(fixtures.input),
        observe: async (port) => await port.health(),
        induceFailure: async (port, fixtures) =>
          await port.produce(fixtures.broken),
        remove: async () => undefined,
        verifyAbsent: async () => absent(),
      },
    });
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
  });
});
