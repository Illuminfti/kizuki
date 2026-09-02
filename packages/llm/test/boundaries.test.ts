import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as llm from "../src/index";
import { MODEL_PRODUCER, ModelProducer } from "../src/producer";
import { claimsPayload, event, portContext, produceInput, scriptedLlm } from "./helpers";

const repoRoot = resolve(import.meta.dir, "../../..");

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
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
    expect(result.stdout.toString().trim()).toBe("");
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/core/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  test("no other package depends on this one", () => {
    // Regression: the CLI used to import the package on every invocation, so
    // the file holding the only fetch was evaluated even by `kizuki version`.
    const result = Bun.spawnSync({
      cmd: [
        "git",
        "grep",
        "-l",
        "@kizuki/llm",
        "--",
        "packages/cli",
        "packages/tui",
        "packages/connectors",
      ],
      cwd: repoRoot,
      stdout: "pipe",
    });
    expect(result.stdout.toString().trim()).toBe("");
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
