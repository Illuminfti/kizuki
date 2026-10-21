import { boundScrubText, sanitizeCapturedText, scrubText, tallyRedactions } from "@kizuki/core/internal";

/**
 * Transcript text is attacker-controlled and the ledger is append-only, so
 * every string is made inert and scrubbed of secrets before it is emitted.
 */

export const MAX_TEXT_BYTES = 32 * 1024;
/**
 * Redaction cost is bounded by cutting text here before any pattern runs. The
 * final cut is 32 KiB, so this leaves room for redaction to shorten the text.
 */
export const MAX_SCAN_CHARS = 128 * 1024;

const LONE_SURROGATE = new RegExp(
  String.raw`[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]`,
  "g",
);

const ANY_SURROGATE = new RegExp(String.raw`[\ud800-\udfff]`);

/** Replaces unpaired surrogates, which no UTF-8 encoding can carry. */
export function wellFormed(text: string): string {
  // The pairing check is slow on megabytes and almost never needed.
  return ANY_SURROGATE.test(text) ? text.replace(LONE_SURROGATE, "\ufffd") : text;
}

export interface Sanitized {
  text: string;
  changed: boolean;
}

/** Drops terminal escapes, control characters, bidi controls and invisible characters. */
export function sanitize(input: string): Sanitized {
  const text = wellFormed(sanitizeCapturedText(input));
  return { text, changed: text !== input };
}

export type Redactions = Record<string, number>;

/**
 * Cuts to `MAX_SCAN_CHARS`, then back to the last whitespace so a secret cut
 * in half at the boundary does not survive as an unredacted prefix.
 */
export function boundScan(input: string): { text: string; truncated: boolean } {
  const bounded = boundScrubText(input, MAX_SCAN_CHARS);
  return { ...bounded, text: wellFormed(bounded.text) };
}

/** Every pattern is linear or bounded, and the input is cut first, so cost does not grow with line size. */
export function redact(input: string): { text: string; redactions: Redactions } {
  const redactions: Redactions = {};
  const scrubbed = scrubText(boundScan(input).text);
  tallyRedactions(redactions, scrubbed.redactions);
  return { text: scrubbed.text, redactions };
}

/** Cuts at a UTF-8 byte bound without splitting a character. */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  const cut = bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
  return { text: cut, truncated: true };
}
