import { describe, expect, test } from "bun:test";
import * as llm from "../src/index";

describe("public surface", () => {
  test("exports the port factories, registry helper, and transport", () => {
    expect(Object.keys(llm).sort()).toEqual([
      "DEFAULT_MAX_RESPONSE_BYTES",
      "DEFAULT_MAX_RETRIES",
      "DEFAULT_TIMEOUT_MS",
      "MAX_RETRIES",
      "MAX_TIMEOUT_MS",
      "MIN_TIMEOUT_MS",
      "NONE_LLM_DESCRIPTOR",
      "NONE_LLM_ID",
      "OPENAI_COMPATIBLE_LLM_DESCRIPTOR",
      "OPENAI_COMPATIBLE_LLM_ID",
      "chatCompletionsUrl",
      "createNoneLlmPort",
      "createOpenAiCompatibleLlmPort",
      "endpointHost",
      "fetchTransport",
      "isLoopbackHost",
      "isRetryableStatus",
      "modelRef",
      "parseChatCompletion",
      "parseOpenAiCompatibleConfig",
      "registerLlmPorts",
    ]);
  });

  test("in-tree descriptors match the RFC inventory", () => {
    expect(llm.NONE_LLM_DESCRIPTOR).toMatchObject({
      id: "kizuki.llm.none",
      kind: "llm",
      contract: "kizuki.llm/v1",
    });
    expect(llm.OPENAI_COMPATIBLE_LLM_DESCRIPTOR).toMatchObject({
      id: "kizuki.llm.openai-compatible",
      kind: "llm",
      contract: "kizuki.llm/v1",
    });
    expect(llm.modelRef("kizuki.llm.openai-compatible", "synthetic", "127.0.0.1")).toBe(
      "kizuki.llm.openai-compatible:synthetic@127.0.0.1",
    );
  });
});
