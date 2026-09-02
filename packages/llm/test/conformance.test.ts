import { afterEach, describe, expect, test } from "bun:test";
import {
  PortRegistry,
  runLlmConformance,
} from "@kizuki/core";
import type { LlmConformanceHarness, LlmPort } from "@kizuki/core";
import {
  NONE_LLM_DESCRIPTOR,
  OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
  createNoneLlmPort,
  createOpenAiCompatibleLlmPort,
  registerLlmPorts,
} from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import {
  SAMPLE_REQUEST,
  SYNTHETIC_TEXT,
  temporaryLlmContext,
} from "./helpers";

function noneHarness(): LlmConformanceHarness {
  return {
    descriptor: NONE_LLM_DESCRIPTOR,
    create: async (ctx) => createNoneLlmPort(ctx),
    destroy: async (port) => port.close(),
    fixtures: { name: "none" },
    driver: {
      apply: async (port) => port.health(),
      observe: async (port) => ({
        model_ref: port.model_ref,
        health: await port.health(),
      }),
      induceFailure: async (port) => port.complete(SAMPLE_REQUEST),
      remove: async (port) => port.close(),
      verifyAbsent: async () => ({ found: [] }),
    },
  };
}

function compatibleHarness(baseUrl: string): LlmConformanceHarness {
  return {
    descriptor: OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
    create: async (ctx) =>
      createOpenAiCompatibleLlmPort({
        ...ctx,
        config: {
          ...ctx.config,
          base_url: baseUrl,
          model: "synthetic",
        },
      }),
    destroy: async (port) => port.close(),
    fixtures: { name: "openai-compatible" },
    driver: {
      apply: async (port) => port.complete(SAMPLE_REQUEST),
      observe: async (port) => port.complete(SAMPLE_REQUEST),
      induceFailure: async (port) =>
        port.complete({ ...SAMPLE_REQUEST, messages: [] }),
      remove: async (port) => port.close(),
      verifyAbsent: async () => ({ found: [] }),
    },
  };
}

const PASS = {
  identity: "pass",
  isolation: "pass",
  idempotence: "pass",
  failure_shape: "pass",
  restart: "pass",
  deletion: "pass",
} as const;

describe("llm conformance", () => {
  let fake: FakeEndpoint | undefined;

  afterEach(() => {
    fake?.stop();
    fake = undefined;
  });

  test("kizuki.llm.none passes the shared suite", async () => {
    const report = await runLlmConformance(noneHarness());
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.families).toEqual(PASS);
  });

  test("kizuki.llm.openai-compatible passes the shared suite against the fake", async () => {
    fake = startFakeEndpoint();
    const report = await runLlmConformance(compatibleHarness(fake.base_url));
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.families).toEqual(PASS);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests[0]?.body).toEqual(
      expect.objectContaining({
        model: "synthetic",
        max_tokens: SAMPLE_REQUEST.max_output_tokens,
      }),
    );
  });

  test("registerLlmPorts binds both in-tree implementations", async () => {
    fake = startFakeEndpoint();
    const registry = new PortRegistry();
    registerLlmPorts(registry);
    expect(registry.listPorts("llm").map((item) => item.id)).toEqual([
      "kizuki.llm.none",
      "kizuki.llm.openai-compatible",
    ]);

    const noneCtx = temporaryLlmContext(NONE_LLM_DESCRIPTOR);
    const compatibleCtx = temporaryLlmContext(
      OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
      { base_url: fake.base_url, model: "synthetic" },
    );
    try {
      const noneBound = registry.bindFromConfig<LlmPort>(
        "llm",
        { llm: "kizuki.llm.none" },
        noneCtx.ctx,
      );
      expect(noneBound.d.id).toBe("kizuki.llm.none");
      expect(noneBound.port.model_ref).toBeNull();

      const bound = registry.bindFromConfig<LlmPort>(
        "llm",
        { llm: "kizuki.llm.openai-compatible" },
        compatibleCtx.ctx,
      );
      const response = await bound.port.complete(SAMPLE_REQUEST);
      expect(response.text).toBe(SYNTHETIC_TEXT);
    } finally {
      noneCtx.cleanup();
      compatibleCtx.cleanup();
    }
  });
});
