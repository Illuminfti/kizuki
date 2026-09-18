import { afterEach, describe, expect, test } from "bun:test";
import { PortError, PortRegistry, runSystemOneConformance } from "@kizuki/core";
import type { SystemOneConformanceHarness, SystemOnePort, SystemOneRequest } from "@kizuki/core";
import {
  SYSTEMONE_JEV_DESCRIPTOR,
  SYSTEMONE_JEV_ID,
  createSystemOneJevPort,
  parseSystemOneJevConfig,
  registerLlmPorts,
  registerSystemOnePorts,
} from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import { CANARY_KEY, temporaryLlmContext } from "./helpers";

const SAMPLE: SystemOneRequest = {
  state: "Grace mentioned she now runs partnerships at Acme.",
  questions: {
    supported: {
      type: "noul",
      instructions: "Is the extracted claim supported?",
    },
  },
  deadline_ms: 5_000,
};

function noulBody(noul = 0.91): Response {
  return Response.json({
    model: "jev-latest",
    answers: { supported: { type: "noul", noul } },
    usage: { input_tokens: 12, output_tokens: 4 },
  });
}

describe("systemone jev config", () => {
  test("defaults to the TypeSafe API and jev-latest", () => {
    expect(parseSystemOneJevConfig({})).toEqual({
      base_url: "https://api.typesafe.ai/v1",
      model: "jev-latest",
      secret_ref: null,
      timeout_ms: 30_000,
      max_retries: 2,
    });
  });

  test("refuses a plaintext key without echoing it", () => {
    let thrown: unknown;
    try {
      parseSystemOneJevConfig({ secret_ref: CANARY_KEY });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PortError);
    expect((thrown as PortError).code).toBe("config_invalid");
    expect((thrown as PortError).message).not.toContain(CANARY_KEY);
  });

  test("refuses unknown keys and userinfo", () => {
    expect(() => parseSystemOneJevConfig({ temperature: 0 })).toThrow(
      "unknown systemone config key temperature",
    );
    expect(() =>
      parseSystemOneJevConfig({ base_url: "http://user:pass@127.0.0.1/v1" }),
    ).toThrow("userinfo");
  });
});

describe("systemone jev port", () => {
  let fake: FakeEndpoint | undefined;

  afterEach(() => {
    fake?.stop();
    fake = undefined;
  });

  test("posts typed questions to /systemone and returns noul answers", async () => {
    fake = startFakeEndpoint(() => noulBody());
    const temporary = temporaryLlmContext(SYSTEMONE_JEV_DESCRIPTOR, {
      base_url: fake.origin + "/v1",
      model: "jev-latest",
      secret_ref: "env:TYPESAFE_API_KEY",
    });
    try {
      const port = createSystemOneJevPort(temporary.ctx);
      const response = await port.evaluate(SAMPLE);
      expect(response.answers.supported).toEqual({ type: "noul", noul: 0.91 });
      expect(fake.requests[0]?.path).toBe("/v1/systemone");
      expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${CANARY_KEY}`);
      expect(fake.requests[0]?.body).toEqual(
        expect.objectContaining({
          model: "jev-latest",
          questions: SAMPLE.questions,
        }),
      );
    } finally {
      temporary.cleanup();
    }
  });

  test("unavailable is not an empty keep", async () => {
    fake = startFakeEndpoint(() => new Response(null, { status: 503 }));
    const temporary = temporaryLlmContext(SYSTEMONE_JEV_DESCRIPTOR, {
      base_url: fake.origin + "/v1",
      max_retries: 0,
    });
    try {
      const port = createSystemOneJevPort(temporary.ctx);
      await expect(port.evaluate(SAMPLE)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      temporary.cleanup();
    }
  });

  test("choice criteria must be a dict, not an array", async () => {
    fake = startFakeEndpoint(() => noulBody());
    const temporary = temporaryLlmContext(SYSTEMONE_JEV_DESCRIPTOR, {
      base_url: fake.origin + "/v1",
      max_retries: 0,
    });
    try {
      const port = createSystemOneJevPort(temporary.ctx);
      await expect(
        port.evaluate({
          state: "synthetic capture",
          questions: {
            sensitivity: {
              type: "choice",
              instructions: "Classify sensitivity.",
              criteria: ["secret", "sensitive"] as unknown as Record<string, string | null>,
            },
          },
          deadline_ms: 5_000,
        }),
      ).rejects.toMatchObject({
        code: "config_invalid",
        message: "choice criteria must be an object",
      });
      expect(fake.requests).toHaveLength(0);
    } finally {
      temporary.cleanup();
    }
  });

  test("schema mismatch is a rejected response, not a default noul", async () => {
    fake = startFakeEndpoint(() =>
      Response.json({ model: "jev-latest", answers: { supported: { type: "choice", choice: "yes" } } }),
    );
    const temporary = temporaryLlmContext(SYSTEMONE_JEV_DESCRIPTOR, {
      base_url: fake.origin + "/v1",
      max_retries: 0,
    });
    try {
      const port = createSystemOneJevPort(temporary.ctx);
      await expect(port.evaluate(SAMPLE)).rejects.toMatchObject({
        message: "rejected: bad_response",
      });
    } finally {
      temporary.cleanup();
    }
  });

  test("registerSystemOnePorts binds jev without replacing llm ports", () => {
    const registry = new PortRegistry();
    registerLlmPorts(registry);
    registerSystemOnePorts(registry);
    expect(registry.listPorts("llm").map((item) => item.id)).toEqual([
      "kizuki.llm.none",
      "kizuki.llm.openai-compatible",
    ]);
    expect(registry.listPorts("systemone").map((item) => item.id)).toEqual([
      SYSTEMONE_JEV_ID,
    ]);
  });

  test("kizuki.systemone.jev passes the shared suite against the fake", async () => {
    fake = startFakeEndpoint(() => noulBody());
    const harness: SystemOneConformanceHarness = {
      descriptor: SYSTEMONE_JEV_DESCRIPTOR,
      create: async (ctx) =>
        createSystemOneJevPort({
          ...ctx,
          config: { ...ctx.config, base_url: fake!.origin + "/v1", model: "jev-latest" },
        }),
      destroy: async (port) => port.close(),
      fixtures: { name: "jev" },
      driver: {
        apply: async (port) => port.evaluate(SAMPLE),
        observe: async (port) => port.evaluate(SAMPLE),
        induceFailure: async (port) =>
          port.evaluate({ ...SAMPLE, questions: {} }),
        remove: async (port) => port.close(),
        verifyAbsent: async () => ({ found: [] }),
      },
    };
    const report = await runSystemOneConformance(harness);
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
  });
});
