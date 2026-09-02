/**
 * The one definition of what this package strips from text it did not write.
 * A model answer, a port's error message and a record's own text all reach a
 * page, a receipt or a terminal, and they must reach it holding what they
 * appear to hold.
 */

/**
 * C0 and C1 controls, newline excepted, plus the delete character, plus the
 * invisible formatting characters a rendered value can be spoofed with: the
 * bidirectional overrides and isolates, the two marks, the zero-width space
 * and the byte-order mark. A subject of "ada\u202emoc.emca" renders as a
 * different string than it holds in any terminal or viewer that honours them.
 * The two joiners (U+200C, U+200D) are deliberately left alone: they carry
 * meaning in Persian and in Indic scripts, so stripping them would corrupt a
 * name rather than protect one.
 */
const CONTROL =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Every break a renderer or a terminal treats as one, including the two
 * separators that are neither C0 nor C1 and would otherwise carry a second
 * line into a value this package promises is single-line.
 */
const LINE_BREAK = /\r\n|\r|\u2028|\u2029/g;

/**
 * Untrusted text, made safe to render. Escapes, NULs, other control
 * characters and the invisible formatting characters are removed before a
 * value can reach a page, a receipt or a terminal.
 */
export function sanitize(value: string, allowNewlines: boolean): string {
  const stripped = value.replace(LINE_BREAK, "\n").replace(CONTROL, "");
  return allowNewlines ? stripped.trim() : stripped.replaceAll("\n", " ").trim();
}
