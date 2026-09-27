import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/cl100k_base";

/** This packet's encoding, not a promise about the downstream model's tokenizer. */
export const PACKET_TOKENIZER_ID = "js-tiktoken@1.0.21/cl100k_base";
let encoding: Tiktoken | undefined;

function vocabulary(): Tiktoken {
  // Most hosts never request a context packet. Build the vocabulary on first use.
  encoding ??= new Tiktoken(ranks);
  return encoding;
}

/** Bundled ranks; special-token-looking source text is encoded as ordinary text. */
export function packetTokens(value: string): number {
  return vocabulary().encode(value, [], []).length;
}

/** Longest prefix of `value` that fits `budget` tokens. One encode, not a search. */
export function packetPrefix(value: string, budget: number): string {
  const tokens = vocabulary().encode(value, [], []);
  if (tokens.length <= budget) return value;
  return vocabulary().decode(tokens.slice(0, budget));
}
