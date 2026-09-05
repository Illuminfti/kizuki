import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/cl100k_base";

/** This packet's encoding, not a promise about the downstream model's tokenizer. */
export const PACKET_TOKENIZER_ID = "js-tiktoken@1.0.21/cl100k_base";
const encoding = new Tiktoken(ranks);

/** Bundled ranks; special-token-looking source text is encoded as ordinary text. */
export function packetTokens(value: string): number {
  return encoding.encode(value, [], []).length;
}
