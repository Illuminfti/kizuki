import type { CaptureEvent } from "../contracts/event";

/**
 * A deterministic check before extraction: a record with nothing a model could
 * turn into a claim never costs a request. The cursor moves past it and the
 * run receipt counts it by reason. The ledger keeps the record, so search,
 * timeline and context still find it.
 */
export const PREFILTER_REASONS = ["empty", "no_words", "too_short"] as const;
export type PrefilterReason = (typeof PREFILTER_REASONS)[number];

/** Letters and digits a record needs before a model is asked about it. */
export const MIN_RECORD_CONTENT_CHARS = 12;

const CONTENT = /[\p{L}\p{N}]/u;
/** One of these carries roughly a word, so it counts for several letters. */
const IDEOGRAPHIC =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const IDEOGRAPHIC_WEIGHT = 4;

/**
 * Why this record is passed over, or null when it goes on to extraction:
 * `empty` for no text at all (an attachment or service notice alone),
 * `no_words` for text with no letter or digit (emoji, punctuation), and
 * `too_short` for fewer than `MIN_RECORD_CONTENT_CHARS` letters and digits.
 */
export function prefilterReason(
  event: Pick<CaptureEvent, "text">,
): PrefilterReason | null {
  let content = 0;
  for (const character of event.text) {
    if (!CONTENT.test(character)) continue;
    content += IDEOGRAPHIC.test(character) ? IDEOGRAPHIC_WEIGHT : 1;
    if (content >= MIN_RECORD_CONTENT_CHARS) return null;
  }
  if (content > 0) return "too_short";
  return event.text.trim() === "" ? "empty" : "no_words";
}
