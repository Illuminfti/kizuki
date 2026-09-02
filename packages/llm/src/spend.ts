/**
 * What a call cost, in the units a budget counts. A retry sends the same
 * prompt again, so the input is charged once per request that went out while
 * the output is charged once: only the request that answered produced any.
 */
import type { LlmSpend } from "@kizuki/core";
import type { ProviderAnswer } from "./response";

/** Four characters per token is the usual rough ratio for English prose. */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
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
