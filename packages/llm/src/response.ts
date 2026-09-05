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
const DATA_KEYS = new Set(["audio", "image", "images", "file", "files", "attachments", "data"]);
const MAX_REASONING_CHARS = 262_144;
const MAX_REASONING_DETAILS = 128;

function unsupportedMetadata(): never {
  throw new PortError("unavailable", "rejected: unsupported_metadata", false);
}

/** Passive provider metadata is validated, then discarded; it is never model input. */
function validateMetadata(message: Record<string, unknown>): void {
  for (const name of ["reasoning", "reasoning_content"] as const) {
    const value = message[name];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > MAX_REASONING_CHARS)) unsupportedMetadata();
  }
  const annotations = message["annotations"];
  if (annotations !== undefined && annotations !== null && (!Array.isArray(annotations) || annotations.length !== 0)) unsupportedMetadata();
  const details = message["reasoning_details"];
  if (details === undefined || details === null) return;
  if (!Array.isArray(details) || details.length > MAX_REASONING_DETAILS) unsupportedMetadata();
  let chars = 0;
  for (const entry of details) {
    if (!isPlainObject(entry)) unsupportedMetadata();
    const field = entry.type === "reasoning.summary" ? "summary" : entry.type === "reasoning.text" ? "text" : entry.type === "reasoning.encrypted" ? "data" : null;
    if (field === null || typeof entry[field] !== "string") unsupportedMetadata();
    const allowed = ["type", field, "id", "format", "index", ...(field === "text" ? ["signature"] : [])];
    for (const [key, value] of Object.entries(entry)) {
      if (!allowed.includes(key)) unsupportedMetadata();
      if (key === "index") {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) unsupportedMetadata();
      } else if (value !== null || (key !== "id" && key !== "signature")) {
        if (typeof value !== "string") unsupportedMetadata();
      }
      if (typeof value === "string") chars += value.length;
    }
    if (chars > MAX_REASONING_CHARS) unsupportedMetadata();
  }
}

function rejectEffectFields(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_MESSAGE_KEYS.has(key) || DATA_KEYS.has(key)) rejectToolCall();
  }
}

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
    if (part["type"] !== "text" || typeof part["text"] !== "string" || Object.keys(part).some(key => key !== "type" && key !== "text")) {
      rejectToolCall();
    }
    parts.push(part["text"]);
  }
  return parts.join("");
}

function readChoiceText(choice: unknown): string {
  if (!isPlainObject(choice)) badResponse();
  rejectEffectFields(choice);
  if (
    choice["finish_reason"] === "tool_calls" ||
    choice["finish_reason"] === "function_call"
  ) {
    rejectToolCall();
  }
  if (choice["finish_reason"] === "length") throw new PortError("unavailable", "rejected: response_truncated", false);
  if (choice["finish_reason"] === "content_filter") throw new PortError("unavailable", "rejected: response_refused", false);
  if (choice["finish_reason"] === "insufficient_system_resource") throw new PortError("unavailable", "rejected: response_incomplete", false);
  if (choice["finish_reason"] !== undefined && choice["finish_reason"] !== "stop") badResponse();

  const message = choice["message"];
  if (!isPlainObject(message)) badResponse();
  rejectEffectFields(message);
  validateMetadata(message);
  if (message["role"] !== "assistant") badResponse();
  if (typeof message["refusal"] === "string") throw new PortError("unavailable", "rejected: response_refused", false);
  if (message["refusal"] !== undefined && message["refusal"] !== null) badResponse();
  if (!("content" in message)) badResponse();

  return readTextContent(message["content"]);
}

export function parseChatCompletion(
  body: unknown,
  fallbackModel: string,
): LlmResponse {
  if (!isPlainObject(body)) badResponse();
  rejectEffectFields(body);
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) badResponse();
  // Validate every choice: a later tool payload invalidates the whole response.
  const texts = choices.map(readChoiceText);

  const model =
    typeof body["model"] === "string" && body["model"].length > 0
      ? body["model"]
      : fallbackModel;

  return {
    text: texts[0]!,
    model,
    usage: readUsage(body["usage"]),
  };
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}
