import { isPlainObject } from "@kizuki/core";
import { reject } from "./errors";

export interface ProviderAnswer {
  text: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * The closed schema of an OpenAI-compatible chat completion. A provider
 * response is attacker-controlled input (AGENTS.md invariant 7), so every
 * level is validated against a key set rather than read field by field: a
 * key nobody in this file named is a refusal, not a warning.
 */
const ANSWER_KEYS = new Set([
  "id",
  "object",
  "created",
  "model",
  "choices",
  "usage",
  "system_fingerprint",
  "service_tier",
]);
const CHOICE_KEYS = new Set(["index", "message", "finish_reason", "logprobs"]);
const MESSAGE_KEYS = new Set(["role", "content", "refusal"]);
const USAGE_KEYS = new Set([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_tokens_details",
  "completion_tokens_details",
]);
const PART_KEYS = new Set(["type", "text"]);

/**
 * Extraction sends no tool definitions, so any of these coming back means the
 * endpoint answered a request nobody made (RFC 0002 §10.1).
 */
const TOOL_KEYS = new Set([
  "tool_calls",
  "function_call",
  "tool_call_id",
  "audio",
  "reasoning_content",
]);

const MAX_CONTENT_PARTS = 64;

function unexpectedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (TOOL_KEYS.has(key)) {
      reject(
        "tool_call_in_response",
        `the endpoint answered with ${key} to a request that offered no tools`,
      );
    }
    if (!allowed.has(key)) {
      reject("schema_invalid", `the endpoint answered with ${where}.${key}`);
    }
  }
}

function integer(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function textOfParts(parts: readonly unknown[]): string {
  if (parts.length === 0 || parts.length > MAX_CONTENT_PARTS) {
    reject("schema_invalid", "the endpoint answered with no usable content");
  }
  const pieces: string[] = [];
  for (const part of parts) {
    if (!isPlainObject(part)) {
      reject(
        "tool_call_in_response",
        "the endpoint answered with a content part that is not text",
      );
    }
    unexpectedKeys(part, PART_KEYS, "content part");
    if (part["type"] !== "text" || typeof part["text"] !== "string") {
      reject(
        "tool_call_in_response",
        "the endpoint answered with a content part that is not text",
      );
    }
    pieces.push(part["text"]);
  }
  return pieces.join("");
}

export function readChatAnswer(body: unknown): ProviderAnswer {
  if (!isPlainObject(body)) {
    reject("schema_invalid", "the endpoint did not return an object");
  }
  unexpectedKeys(body, ANSWER_KEYS, "answer");

  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length !== 1) {
    reject("schema_invalid", "the endpoint did not return exactly one choice");
  }
  const choice = choices[0];
  if (!isPlainObject(choice)) {
    reject("schema_invalid", "the endpoint returned a choice that is not an object");
  }
  unexpectedKeys(choice, CHOICE_KEYS, "choice");

  const message = choice["message"];
  if (!isPlainObject(message)) {
    reject("schema_invalid", "the endpoint returned no choice message");
  }
  unexpectedKeys(message, MESSAGE_KEYS, "message");
  if (message["role"] !== "assistant") {
    reject("schema_invalid", "the endpoint answered in an unexpected role");
  }

  const content = message["content"];
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? textOfParts(content)
        : reject("schema_invalid", "the endpoint returned no message content");

  const usage = body["usage"];
  if (usage !== undefined && !isPlainObject(usage)) {
    reject("schema_invalid", "the endpoint returned a usage that is not an object");
  }
  if (isPlainObject(usage)) unexpectedKeys(usage, USAGE_KEYS, "usage");

  const model = body["model"];
  return {
    text,
    model: typeof model === "string" && model.length <= 200 ? model : null,
    input_tokens: isPlainObject(usage) ? integer(usage["prompt_tokens"]) : null,
    output_tokens: isPlainObject(usage)
      ? integer(usage["completion_tokens"])
      : null,
  };
}
