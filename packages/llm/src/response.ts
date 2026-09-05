import {
  PortError,
  isPlainObject,
} from "@kizuki/core";
import type { LlmResponse, LlmUsage } from "@kizuki/core";

const TOOL_REJECT = "rejected: tool_call_in_response";
const BAD_RESPONSE = "rejected: bad_response";

const FORBIDDEN_MESSAGE_KEYS = new Set([
  "tool_calls",
  "function_call",
  "function_calls",
  "tool_call_id",
]);

function rejectToolCall(): never {
  throw new PortError("not_supported", TOOL_REJECT, false);
}

function badResponse(): never {
  throw new PortError("unavailable", BAD_RESPONSE, false);
}

function readUsage(value: unknown): LlmUsage {
  if (value === undefined) {
    return { input_tokens: 0, output_tokens: 0 };
  }
  if (!isPlainObject(value)) badResponse();
  const input = value["prompt_tokens"];
  const output = value["completion_tokens"];
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isSafeInteger(output) ||
    output < 0
  ) {
    badResponse();
  }
  return { input_tokens: input, output_tokens: output };
}

function readTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) badResponse();

  const parts: string[] = [];
  for (const part of content) {
    if (!isPlainObject(part)) badResponse();
    if (part["type"] !== "text" || typeof part["text"] !== "string") {
      rejectToolCall();
    }
    parts.push(part["text"]);
  }
  return parts.join("");
}

export function parseChatCompletion(
  body: unknown,
  fallbackModel: string,
): LlmResponse {
  if (!isPlainObject(body)) badResponse();
  if ("tool_calls" in body || "function_call" in body) {
    rejectToolCall();
  }

  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) badResponse();
  const choice = choices[0];
  if (!isPlainObject(choice)) badResponse();
  if (
    choice["finish_reason"] === "tool_calls" ||
    choice["finish_reason"] === "function_call"
  ) {
    rejectToolCall();
  }

  const message = choice["message"];
  if (!isPlainObject(message)) badResponse();
  // The forbidden set is the security boundary (RFC 0002 §10.1): a key
  // outside it — `reasoning`, `provider`, or anything else a provider adds —
  // is ignored, never read, never propagated into a claim or a page.
  for (const key of Object.keys(message)) {
    if (FORBIDDEN_MESSAGE_KEYS.has(key)) rejectToolCall();
  }
  if (!("content" in message)) badResponse();

  const model =
    typeof body["model"] === "string" && body["model"].length > 0
      ? body["model"]
      : fallbackModel;

  return {
    text: readTextContent(message["content"]),
    model,
    usage: readUsage(body["usage"]),
  };
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}
