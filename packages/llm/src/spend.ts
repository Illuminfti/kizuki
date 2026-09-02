/**
 * What a call cost, in the units a budget counts. A retry sends the same
 * prompt again, so the input is charged once per request that went out while
 * the output is charged once: only the request that answered produced any.
 */
import type { LlmSpend } from "@kizuki/core";
import type { ProviderAnswer } from "./response";

/** Four characters per token is the usual rough ratio for English prose. */
const CHARS_PER_TOKEN = 4;

/** What a chat template adds around one message: a role, a turn, a separator. */
const MESSAGE_FRAMING_TOKENS = 8;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** UTF-8 bytes, counted without encoding the string to get at them. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * What a request is expected to cost in input tokens, in the unit the charge
 * is counted in. A byte-fallback tokenizer emits a token per UTF-8 byte it
 * has no piece for, so a character count under-reserves for text outside
 * Latin script, and a chat template frames every message besides. One token
 * per character is no bound either: it reserves about four times what an
 * endpoint reports for English prose, which refuses calls the budget could
 * comfortably pay for. Nothing without a tokenizer can prove a bound, so this
 * is an estimate at the ratio the charge uses, and the budget line itself is
 * enforced against what the endpoint reports after every call.
 */
export function requestTokens(...messages: readonly string[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(utf8Length(message)) + MESSAGE_FRAMING_TOKENS;
  }
  return total;
}

/** Nothing reached the endpoint, so the call owes nothing for it. */
export const NOTHING_SPENT: LlmSpend = {
  attempts: 0,
  input_tokens: 0,
  output_tokens: 0,
};

export function answeredSpend(
  answer: ProviderAnswer | null,
  attempts: number,
  inputChars: number,
): LlmSpend {
  const input = answer?.input_tokens ?? estimateTokens(inputChars);
  const output =
    answer === null
      ? 0
      : (answer.output_tokens ?? estimateTokens(answer.text.length));
  return { attempts, input_tokens: input * attempts, output_tokens: output };
}

/** What a call that never reached an answer had already put on the wire. */
export function unansweredSpend(
  attempts: number,
  inputChars: number,
): LlmSpend {
  return {
    attempts,
    input_tokens: estimateTokens(inputChars) * attempts,
    output_tokens: 0,
  };
}
