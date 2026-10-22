import { expect, test } from "bun:test";
import { LLM_CONTRACT_MINOR, llmInputTokenOverhead } from "@kizuki/core";
import { OPENAI_COMPATIBLE_LLM_DESCRIPTOR, createOpenAiCompatibleLlmPort, parseOpenAiCompatibleConfig } from "../src/index";
import { completionBody, SAMPLE_REQUEST, temporaryLlmContext } from "./helpers";

const config = { base_url: "http://127.0.0.1:9/v1", model: "synthetic", max_retries: 0 };

test("input_token_overhead accepts only bounded safe integers and defaults to zero", () => {
  expect(parseOpenAiCompatibleConfig(config).input_token_overhead).toBe(0);
  for (const overhead of [0, 24_000, 32_000]) {
    const parsed = parseOpenAiCompatibleConfig({ ...config, input_token_overhead: overhead });
    expect(parsed.input_token_overhead).toBe(overhead);
    expect(parseOpenAiCompatibleConfig({ ...parsed })).toEqual(parsed);
  }
  for (const overhead of [-1, 32_001, 1.1, NaN, Infinity, null, "24000", true, {}, []]) {
    expect(() => parseOpenAiCompatibleConfig({ ...config, input_token_overhead: overhead })).toThrow("input_token_overhead");
  }
});

test("trusted reserve appears in minor-one port metadata and health, never the wire or usage", async () => {
  const context = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, { ...config, input_token_overhead: 24_000 });
  let wire: unknown;
  try {
    const port = createOpenAiCompatibleLlmPort(context.ctx, { transport: async request => {
      wire = request.body;
      return { ok: true, kind: "ok", status: 200, body: completionBody("synthetic") };
    } });
    expect(LLM_CONTRACT_MINOR).toBe(1);
    expect(port.descriptor.contract_minor).toBe(1);
    expect(port.input_token_overhead).toBe(24_000);
    expect(llmInputTokenOverhead(port)).toBe(24_000);
    expect(await port.health()).toMatchObject({ detail: { input_token_overhead: 24_000 } });
    expect((await port.complete(SAMPLE_REQUEST)).usage).toEqual({ input_tokens: 8, output_tokens: 4 });
    expect(wire).not.toHaveProperty("input_token_overhead");
    expect(JSON.stringify(wire)).not.toContain("24000");
  } finally { context.cleanup(); }
});
