import { describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import { parseChatCompletion } from "../src/response";
import { completionBody } from "./helpers";

const TOOL_REJECT = "rejected: tool_call_in_response";
const BAD_RESPONSE = "rejected: bad_response";

/**
 * RFC 0002 §10.1/§12.1: a provider response is attacker-controlled input.
 * The forbidden set is the security boundary; everything outside it is
 * ignored, never fatal. These tests prove the boundary holds key by key,
 * not just for the two keys the injection suite already exercises.
 */
describe("parseChatCompletion message-key boundary", () => {
  const forbidden: Record<string, unknown> = {
    tool_calls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{}" } }],
    function_call: { name: "x", arguments: "{}" },
    function_calls: [{ name: "x", arguments: "{}" }],
    tool_call_id: "call-1",
  };

  for (const [key, value] of Object.entries(forbidden)) {
    test(`a message carrying ${key} is rejected as a tool call`, () => {
      const body = completionBody("ok", {
        message: { role: "assistant", content: "ok", [key]: value },
      });
      expect(() => parseChatCompletion(body, "synthetic")).toThrow(PortError);
      try {
        parseChatCompletion(body, "synthetic");
        throw new Error("expected parseChatCompletion to throw");
      } catch (error) {
        expect((error as PortError).code).toBe("not_supported");
        expect((error as PortError).message).toBe(TOOL_REJECT);
        expect((error as PortError).retryable).toBe(false);
      }
    });
  }

  test("finish_reason tool_calls is rejected even with a clean message", () => {
    const body = completionBody("ok", { finish_reason: "tool_calls" });
    expect(() => parseChatCompletion(body, "synthetic")).toThrow(TOOL_REJECT);
  });

  test("finish_reason function_call is rejected even with a clean message", () => {
    const body = completionBody("ok", { finish_reason: "function_call" });
    expect(() => parseChatCompletion(body, "synthetic")).toThrow(TOOL_REJECT);
  });

  test("a top-level tool_calls field is rejected", () => {
    const body = completionBody("ok");
    (body as Record<string, unknown>)["tool_calls"] = [];
    expect(() => parseChatCompletion(body, "synthetic")).toThrow(TOOL_REJECT);
  });

  test("a top-level function_call field is rejected", () => {
    const body = completionBody("ok");
    (body as Record<string, unknown>)["function_call"] = {};
    expect(() => parseChatCompletion(body, "synthetic")).toThrow(TOOL_REJECT);
  });

  test("a response missing content is a bad response, not a tool-call rejection", () => {
    const body = completionBody("ok", {
      message: { role: "assistant" },
    });
    expect(() => parseChatCompletion(body, "synthetic")).toThrow(BAD_RESPONSE);
  });
});

describe("parseChatCompletion unknown-key tolerance", () => {
  const benign: Record<string, unknown> = {
    reasoning: "We need answer single sentence, keep it short.",
    reasoning_content: "internal chain of thought",
    provider: "StreamLake",
    system_fingerprint: "fp_abc123",
    native_finish_reason: "stop",
    logprobs: null,
    audio: { id: "audio-1" },
    annotations: [],
  };

  for (const [key, value] of Object.entries(benign)) {
    test(`a message carrying unknown key ${key} still parses`, () => {
      const body = completionBody("ok", {
        message: { role: "assistant", content: "ok", refusal: null, [key]: value },
      });
      const response = parseChatCompletion(body, "synthetic");
      expect(response.text).toBe("ok");
    });
  }

  test("a full OpenRouter-shaped body parses and only content is used", () => {
    const body = {
      id: "gen-synthetic",
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "StreamLake",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          native_finish_reason: "stop",
          logprobs: null,
          message: {
            role: "assistant",
            content: "Grace runs partnerships at Acme.",
            refusal: null,
            reasoning:
              "We need to determine the employment claim from the quoted record and answer briefly.",
          },
        },
      ],
      system_fingerprint: "fp_abc123",
      usage: { prompt_tokens: 120, completion_tokens: 12 },
    };
    const response = parseChatCompletion(body, "deepseek/deepseek-v4-flash-0731");
    expect(response.text).toBe("Grace runs partnerships at Acme.");
    expect(response.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(response.usage).toEqual({ input_tokens: 120, output_tokens: 12 });
    expect(JSON.stringify(response)).not.toContain("reasoning");
    expect(JSON.stringify(response)).not.toContain("StreamLake");
  });
});
