import { describe, expect, test } from "bun:test";
import * as llm from "../src/index";

describe("public surface", () => {
  test("exports exactly the documented runtime values", () => {
    expect(Object.keys(llm).sort()).toEqual([
      "CONFIDENCE_CAPS",
      "ChatClient",
      "ENTITY_TYPES",
      "LLM_CONFIG_DEFAULTS",
      "LLM_CONFIG_PATH",
      "LlmError",
      "OUTPUT_LIMITS",
      "PRODUCERS",
      "PROMPT_VERSION",
      "UNLABELED_MODES",
      "claimsDraft",
      "endpointHost",
      "entityDrafts",
      "entityTarget",
      "fetchTransport",
      "initLlm",
      "isLoopbackUrl",
      "lastRun",
      "listRuns",
      "parseLlmConfig",
      "parseModelJson",
      "readLlmConfig",
      "removeLlmConfig",
      "resolveApiKey",
      "runEnrichment",
      "sanitizeBlock",
      "sanitizeLine",
      "serializeLlmConfig",
      "slugify",
      "summaryDraft",
      "systemPrompt",
      "targetRelPath",
      "validateClaims",
      "validateEntities",
      "validateSummary",
      "wrapEvent",
      "writeLlmConfig",
    ]);
  });
});
