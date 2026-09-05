import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/cl100k_base";

/** This packet's encoding, not a promise about the downstream model's tokenizer. */
export const PACKET_TOKENIZER_ID = "js-tiktoken@1.0.21/cl100k_base";
let encoding: Tiktoken | undefined;

/** Bundled ranks; special-token-looking source text is encoded as ordinary text. */
export function packetTokens(value: string): number {
  // Most hosts never request a context packet. Build the vocabulary on first use.
  encoding ??= new Tiktoken(ranks);
  return encoding.encode(value, [], []).length;
}
