import { isPlainObject } from "@kizuki/core";
import { reject } from "./errors";

export interface ProviderAnswer {
  text: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * Extraction sends no tool definitions, so any of these coming back means the
 * endpoint answered a request nobody made (RFC 0002 §10.1). This is the one
 * closed set on the envelope: every OpenAI-compatible server adds fields of
 * its own — timings, log probabilities, cache counters, a vendor block — and
 * refusing those would burn a paid request per pass against a working
 * endpoint while proving nothing about the answer.
 */
const TOOL_KEYS = new Set(["tool_calls", "function_call", "tool_call_id"]);

const MAX_CONTENT_PARTS = 64;
const MAX_MODEL_CHARS = 200;

/**
 * Stops that mean the endpoint finished the answer it was asked for. Anything
 * else — a token limit, a content filter, a tool call — makes the content
 * unusable, and an unusable answer must never look like "these records held
 * nothing durable".
 */
const FINISHED = new Set(["stop", "eos", "end_turn"]);
const CALLED_A_TOOL = new Set(["tool_calls", "function_call"]);

function refuseToolFields(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (TOOL_KEYS.has(key)) {
      reject(
        "tool_call_in_response",
        `the endpoint answered with ${key} to a request that offered no tools`,
      );
    }
  }
}

/**
 * A count the endpoint reported. Absent is absent, but present and malformed
 * is a refusal: a negative or fractional token count would otherwise be
 * silently replaced by an estimate and charged as if it were measured.
 */
function tokenCount(usage: Record<string, unknown>, key: string): number | null {
  const raw = usage[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    reject("schema_invalid", `the endpoint reported an invalid usage.${key}`);
  }
  return raw;
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
    refuseToolFields(part);
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
  refuseToolFields(body);

  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length !== 1) {
    reject("schema_invalid", "the endpoint did not return exactly one choice");
  }
  const choice = choices[0];
  if (!isPlainObject(choice)) {
    reject("schema_invalid", "the endpoint returned a choice that is not an object");
  }
  refuseToolFields(choice);

  const finish = choice["finish_reason"];
  if (finish !== undefined && finish !== null && !FINISHED.has(String(finish))) {
    if (typeof finish === "string" && CALLED_A_TOOL.has(finish)) {
      reject(
        "tool_call_in_response",
        "the endpoint stopped to call a tool the request never offered",
      );
    }
    reject(
      "schema_invalid",
      "the endpoint stopped before it finished a usable answer",
    );
  }

  const message = choice["message"];
  if (!isPlainObject(message)) {
    reject("schema_invalid", "the endpoint returned no choice message");
  }
  refuseToolFields(message);
  if (message["role"] !== "assistant") {
    reject("schema_invalid", "the endpoint answered in an unexpected role");
  }
  const refusal = message["refusal"];
  if (refusal !== undefined && refusal !== null && refusal !== "") {
    // The refusal text is the provider's prose about captured content, so it
    // is counted and never carried into the message this throws.
    reject("schema_invalid", "the endpoint declined to answer");
  }

  const content = message["content"];
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? textOfParts(content)
        : reject("schema_invalid", "the endpoint returned no message content");

  const usage = body["usage"];
  if (usage !== undefined && usage !== null && !isPlainObject(usage)) {
    reject("schema_invalid", "the endpoint returned a usage that is not an object");
  }
  const counted = isPlainObject(usage) ? usage : null;

  const model = body["model"];
  if (
    model !== undefined &&
    model !== null &&
    (typeof model !== "string" || model.length > MAX_MODEL_CHARS)
  ) {
    reject("schema_invalid", "the endpoint reported an invalid model");
  }
  return {
    text,
    model: typeof model === "string" ? model : null,
    input_tokens: counted === null ? null : tokenCount(counted, "prompt_tokens"),
    output_tokens:
      counted === null ? null : tokenCount(counted, "completion_tokens"),
  };
}
