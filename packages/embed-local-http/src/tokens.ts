/**
 * Kizuki ships no model tokenizer, so token counts are an estimate that errs
 * high: a chunk sized by it fits the model's window, at the price of somewhat
 * smaller chunks. The estimate is additive over whitespace, which lets an
 * engine size chunks word by word and still agree with a count of the whole
 * framed text.
 *
 * - a run of ASCII letters costs one token per three letters, rounded up
 * - a run of digits costs one token per two digits, rounded up
 * - a letter outside ASCII costs one token
 * - any other visible character costs one token
 */
export const TOKENIZER_ID = "kizuki:estimate-v1";

const PIECES = /\p{L}+|\p{N}+|[^\s\p{L}\p{N}]/gu;
const ASCII_LETTER = /^[A-Za-z]+$/;

function letterRun(run: string): number {
  if (ASCII_LETTER.test(run)) return Math.ceil(run.length / 3);
  let tokens = 0;
  let ascii = 0;
  for (const character of run) {
    if (character.charCodeAt(0) < 128) ascii += 1;
    else {
      tokens += Math.ceil(ascii / 3) + 1;
      ascii = 0;
    }
  }
  return tokens + Math.ceil(ascii / 3);
}

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const match of text.matchAll(PIECES)) {
    const piece = match[0];
    const first = piece.codePointAt(0)!;
    if (/\p{L}/u.test(String.fromCodePoint(first))) tokens += letterRun(piece);
    else if (/\p{N}/u.test(String.fromCodePoint(first)))
      tokens += Math.ceil([...piece].length / 2);
    else tokens += 1;
  }
  return tokens;
}

/** The longest prefix of whole words that fits `budget` tokens. */
export function truncateToTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  const kept: string[] = [];
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const cost = estimateTokens(word);
    if (used + cost > budget) break;
    kept.push(word);
    used += cost;
  }
  return kept.join(" ");
}
