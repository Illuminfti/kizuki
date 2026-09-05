import { describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import { createOpenAiCompatibleLlmPort, OPENAI_COMPATIBLE_LLM_DESCRIPTOR, parseChatCompletion } from "../src/index";
import { completionBody, SAMPLE_REQUEST, temporaryLlmContext } from "./helpers";
import { startFakeEndpoint } from "./fake-endpoint";

const CANARY = "synthetic-private-reasoning-canary";
const reasoning = [
  { type: "reasoning.summary", summary: CANARY, id: "synthetic", format: "openai-responses-v1", index: 0 },
  { type: "reasoning.text", text: CANARY, signature: null },
  { type: "reasoning.encrypted", data: CANARY },
];

function message(extra: Record<string, unknown>) {
  return completionBody("usable content", { message: { role: "assistant", content: "usable content", refusal: null, ...extra } });
}

describe("documented response metadata", () => {
  test("OpenRouter-shaped envelopes and unread keys never enter the projected result", () => {
    const body: Record<string, unknown> = {
      ...message({
        reasoning: CANARY,
        reasoning_content: CANARY,
        reasoning_details: reasoning,
        annotations: [],
        name: CANARY,
        parsed: { tool: CANARY },
        [CANARY]: { tool_calls: [CANARY] },
      }),
      provider: CANARY,
      system_fingerprint: CANARY,
    };
    (body.choices as Record<string, unknown>[])[0]!.native_finish_reason = "stop";
    (body.choices as Record<string, unknown>[])[0]!.logprobs = null;
    const result = parseChatCompletion(body, "synthetic");
    expect(result).toEqual({ text: "usable content", model: "synthetic", usage: { input_tokens: 8, output_tokens: 4 } });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  test("malformed named passive shapes refuse without echoing input", () => {
    for (const extra of [
      { reasoning: { text: CANARY } },
      { reasoning_details: [{ type: "tool_call", arguments: CANARY }] },
      { reasoning_details: [{ type: "reasoning.text", text: CANARY, unexpected: CANARY }] },
      { reasoning_details: Array.from({ length: 129 }, () => reasoning[0]) },
      { reasoning: "x".repeat(262_145) },
      { annotations: [{ text: CANARY }] },
    ]) {
      expect(() => parseChatCompletion(message(extra), "synthetic")).toThrow("rejected: unsupported_metadata");
      try { parseChatCompletion(message(extra), "synthetic"); } catch (error) {
        expect(String(error)).not.toContain(CANARY);
        expect((error as PortError).retryable).toBe(false);
      }
    }
  });

  for (const key of ["tool_calls", "function_call", "function_calls", "tool_call_id"]) {
    test(`${key} refuses at body, choice and message, even empty`, () => {
      const nested = completionBody("ok");
      (nested.choices as Record<string, unknown>[])[0]![key] = null;
      for (const body of [{ ...completionBody("ok"), [key]: [] }, nested, message({ [key]: null })]) {
        expect(() => parseChatCompletion(body, "synthetic")).toThrow("rejected: tool_call_in_response");
      }
    });
  }

  for (const key of ["audio", "image", "images", "file", "files", "attachments", "data"]) {
    test(`${key} refuses at body, choice and message, even empty`, () => {
      const nested = completionBody("ok");
      (nested.choices as Record<string, unknown>[])[0]![key] = null;
      for (const body of [{ ...completionBody("ok"), [key]: [] }, nested, message({ [key]: null })]) {
        expect(() => parseChatCompletion(body, "synthetic")).toThrow("rejected: tool_call_in_response");
      }
    });
  }

  test("a text part cannot hide a data field and message roles are checked", () => {
    expect(() => parseChatCompletion(message({ content: [{ type: "text", text: "ok", data: CANARY }] }), "synthetic")).toThrow("rejected: tool_call_in_response");
    expect(() => parseChatCompletion(message({ role: "tool" }), "synthetic")).toThrow("rejected: bad_response");
    expect(() => parseChatCompletion(message({ audio: { data: CANARY } }), "synthetic")).toThrow("rejected: tool_call_in_response");
  });

  test("a later choice cannot conceal a tool or non-text response", () => {
    for (const extra of [{ tool_calls: [] }, { content: [{ type: "image_url", image_url: { url: CANARY } }] }]) {
      const body = completionBody("first answer");
      (body.choices as Record<string, unknown>[]).push({ message: { role: "assistant", content: "second answer", ...extra } });
      expect(() => parseChatCompletion(body, "synthetic")).toThrow("rejected: tool_call_in_response");
    }
  });

  test("a refusal or interrupted completion is never usable text", () => {
    expect(() => parseChatCompletion(message({ refusal: CANARY }), "synthetic")).toThrow("rejected: response_refused");
    expect(() => parseChatCompletion(completionBody("{}", { finish_reason: "length" }), "synthetic")).toThrow("rejected: response_truncated");
    expect(() => parseChatCompletion(completionBody("{}", { finish_reason: "content_filter" }), "synthetic")).toThrow("rejected: response_refused");
  });

  test("a fake OpenRouter-shaped endpoint still extracts text", async () => {
    const endpoint = startFakeEndpoint(() => Response.json({
      id: "gen-synthetic",
      model: "synthetic",
      provider: CANARY,
      choices: [{
        finish_reason: "stop",
        native_finish_reason: "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content: "usable content",
          refusal: null,
          reasoning: CANARY,
          name: CANARY,
          [CANARY]: { data: CANARY },
        },
      }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    }));
    const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, { base_url: endpoint.base_url, model: "synthetic", max_retries: 0 });
    try {
      const port = createOpenAiCompatibleLlmPort(temporary.ctx);
      await expect(port.complete(SAMPLE_REQUEST)).resolves.toEqual({
        text: "usable content",
        model: "synthetic",
        usage: { input_tokens: 8, output_tokens: 4 },
      });
      expect(endpoint.requests).toHaveLength(1);
      await port.close();
    } finally { endpoint.stop(); temporary.cleanup(); }
  });

  test("a real fake endpoint refuses deterministic response failures once", async () => {
    const responses = [message({ annotations: [{ text: CANARY }] }), message({ refusal: CANARY }), message({ tool_calls: [] }),
      completionBody("{}", { finish_reason: "length" }), { ...completionBody("{}"), usage: { prompt_tokens: CANARY, completion_tokens: 1 } }]
      .map(body => () => Response.json(body));
    responses.push(() => new Response("{invalid JSON"), () => new Response("x".repeat(2_097_153)));
    for (const respond of responses) {
      const endpoint = startFakeEndpoint(respond);
      const temporary = temporaryLlmContext(OPENAI_COMPATIBLE_LLM_DESCRIPTOR, { base_url: endpoint.base_url, model: "synthetic", max_retries: 3 });
      try {
        const port = createOpenAiCompatibleLlmPort(temporary.ctx);
        await expect(port.complete(SAMPLE_REQUEST)).rejects.toThrow("rejected:");
        expect(endpoint.requests).toHaveLength(1);
        await port.close();
      } finally { endpoint.stop(); temporary.cleanup(); }
    }
  });
});
