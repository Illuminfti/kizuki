/**
 * Model tokenizers are not portable across the two embedding APIs. Budget one
 * token per UTF-8 byte, including whitespace: this is a conservative bound for
 * byte-level BPE and byte-fallback tokenizers, not an exact model token count.
 * The configured window also reserves the model's framing tokens. Servers
 * with other tokenization or input expansion need a correspondingly smaller
 * configured window; Ollama is additionally told to refuse truncation.
 */
export const TOKENIZER_ID = "kizuki:utf8-bytes-v1";

export function estimateTokens(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The longest Unicode-safe prefix that fits the byte budget. */
export function truncateToTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let used = 0;
  let end = 0;
  for (const character of text) {
    const cost = estimateTokens(character);
    if (used + cost > budget) break;
    used += cost;
    end += character.length;
  }
  return text.slice(0, end);
}
