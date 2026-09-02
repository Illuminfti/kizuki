import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LLM_CONTRACT_MINOR,
  PRODUCER_CONTRACT_MINOR,
  PortRegistry,
} from "@kizuki/core";
import type { LlmPort } from "@kizuki/core";
import * as llm from "../src/index";
import {
  OPENAI_COMPATIBLE_LLM,
  OPENAI_COMPATIBLE_LLM_ID,
  openAiCompatibleLlm,
} from "../src/llm-port";
import { MODEL_PRODUCER, ModelProducer } from "../src/producer";
import { chatCompletion, startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import { claimsPayload, event, portContext, produceInput, scriptedLlm } from "./helpers";

const repoRoot = resolve(import.meta.dir, "../../..");

const cleanups: (() => void)[] = [];
let endpoint: FakeEndpoint | undefined;

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  await endpoint?.stop();
  endpoint = undefined;
});

describe("the package boundary", () => {
  test("the public surface is exactly what the lane advertises", () => {
    expect(Object.keys(llm).sort()).toEqual([
      "EXTRACT_BATCH",
      "EXTRACT_INPUT_CHARS",
      "EXTRACT_PROMPT_OVERHEAD_CHARS",
      "LlmRejection",
      "MODEL_PRODUCER",
      "MODEL_PRODUCER_ID",
      "ModelProducer",
      "OPENAI_COMPATIBLE_LLM",
      "OPENAI_COMPATIBLE_LLM_ID",
      "OpenAiCompatibleLlm",
      "SYSTEM_PROMPT",
      "batchEvents",
      "buildExtractPrompt",
      "clipText",
      "escapeFence",
      "estimateTokens",
      "fetchTransport",
      "leaksFence",
      "modelProducer",
      "openAiCompatibleLlm",
      "parseExtractResponse",
      "quoteNonce",
      "readBoundedBody",
      "readChatAnswer",
      "readLlmPortConfig",
      "rejectionOf",
    ]);
  });

  test("each descriptor pins the minor its implementation provides", () => {
    // Regression: both descriptors re-exported the contract's current minor,
    // so the next additive field would have inflated them into promising a
    // feature nothing here implements (RFC 0002 3.3).
    expect(OPENAI_COMPATIBLE_LLM.contract_minor).toBe(1);
    expect(MODEL_PRODUCER.contract_minor).toBe(1);
    expect(OPENAI_COMPATIBLE_LLM.contract_minor).toBeLessThanOrEqual(
      LLM_CONTRACT_MINOR,
    );
    expect(MODEL_PRODUCER.contract_minor).toBeLessThanOrEqual(
      PRODUCER_CONTRACT_MINOR,
    );
    // Both live in a workspace package a distribution can leave out, which is
    // what this field is for; core cannot construct either one.
    expect(OPENAI_COMPATIBLE_LLM.optional_package).toBe("@kizuki/llm");
    expect(MODEL_PRODUCER.optional_package).toBe("@kizuki/llm");
  });

  test("the package takes no dependency beyond the core contracts", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/llm/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies).toEqual({ "@kizuki/core": "workspace:*" });
  });

  test("core cannot reach the network package", () => {
    const result = Bun.spawnSync({
      cmd: ["git", "grep", "-l", "@kizuki/llm", "--", "packages/core"],
      cwd: repoRoot,
      stdout: "pipe",
    });
    // Exit 1 is "no match"; anything else is a scan that did not run, which
    // an empty stdout would otherwise read as a pass.
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString().trim()).toBe("");
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/core/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  test("the registry factory binds the port a config selects", async () => {
    endpoint = startFakeEndpoint([{ body: chatCompletion('{"claims":[]}') }]);
    const built = portContext(OPENAI_COMPATIBLE_LLM, {
      base_url: `${endpoint.url}/v1`,
      model: "m",
    });
    cleanups.push(built.cleanup);
    // A fresh registry rather than the process-wide one: registering the same
    // id twice is an error, and a test must not decide what a host has bound.
    const registry = new PortRegistry();
    registry.registerPort(OPENAI_COMPATIBLE_LLM, openAiCompatibleLlm);
    const bound = registry.bindFromConfig<LlmPort>(
      "llm",
      { llm: OPENAI_COMPATIBLE_LLM_ID },
      built.ctx,
    );
    expect(bound.d.contract).toBe("kizuki.llm/v1");
    const answer = await bound.port.complete({
      messages: [{ role: "user", content: "hi" }],
      max_output_tokens: 32,
      deadline_ms: 5_000,
    });
    expect(answer.text).toBe('{"claims":[]}');
    await bound.port.close();
  });

  test("producing over an in-process model port never calls fetch", async () => {
    const built = portContext(MODEL_PRODUCER);
    cleanups.push(built.cleanup);
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        called += 1;
        throw new Error("the producer reached the network");
      },
      { preconnect: original.preconnect.bind(original) },
    );
    try {
      const port = new ModelProducer(built.ctx, scriptedLlm([claimsPayload()]));
      const result = await port.produce(
        produceInput([event("ev-1", "Ada joined acme.")]),
      );
      expect(result.status).toBe("ok");
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(0);
  });
});
