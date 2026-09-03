/**
 * Nonce fencing for captured text (RFC 0002 §10.2).
 *
 * Captured text is attacker-controlled. It is placed only in the user role,
 * only between two markers that carry a per-call 128-bit nonce, and never
 * used to build the request's structure. A response that echoes the nonce or
 * either marker was steered by fenced content and is discarded.
 */

export const FENCE_OPEN = "<<<KZ-QUOTE" as const;
export const FENCE_CLOSE = "<<<KZ-END" as const;
export const FENCE_NONCE_BYTES = 16;
export const FENCE_NONCE_HEX = /^[0-9a-f]{32}$/;

/** Any `<<<KZ-` run inside captured text, whatever the case. */
const FENCE_LOOKALIKE = /<<<KZ-/gi;
/** Escaped form: the hyphen is backslash-escaped so no marker can form. */
function escapeLookalike(match: string): string {
  return `${match.slice(0, -1)}\\-`;
}
const FENCE_MARKER = /<<<KZ-(?:QUOTE|END)\b/i;

/** Labels are producer-chosen and bounded; never derived from captured text. */
const FENCE_LABEL = /^[A-Za-z][A-Za-z0-9:_.-]{0,79}$/;

export function newFenceNonce(): string {
  const bytes = new Uint8Array(FENCE_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function isFenceNonce(value: unknown): value is string {
  return typeof value === "string" && FENCE_NONCE_HEX.test(value);
}

/**
 * Neutralizes marker look-alikes inside captured text so the only markers in
 * the request are the ones the producer wrote. Idempotent: escaped text
 * contains no `<<<KZ-` run, so a second pass changes nothing.
 */
export function escapeFenceText(text: string): string {
  return text.replace(FENCE_LOOKALIKE, escapeLookalike);
}

export function fenceBlock(
  nonce: string,
  label: string,
  text: string,
): string {
  if (!isFenceNonce(nonce)) {
    throw new RangeError("fence nonce must be 32 lowercase hex characters");
  }
  if (!FENCE_LABEL.test(label)) {
    throw new RangeError("fence label is not a bounded producer label");
  }
  const escaped = escapeFenceText(text);
  return `${FENCE_OPEN} ${nonce} ${label}>>>\n${escaped}\n${FENCE_CLOSE} ${nonce}>>>`;
}

/**
 * True when a model response carries the nonce or either marker. The check
 * runs on the raw response text before any parsing, so a leak inside a JSON
 * string, a code fence, or trailing prose is caught the same way.
 */
export function hasFenceLeak(response: string, nonce: string): boolean {
  if (!isFenceNonce(nonce)) {
    throw new RangeError("fence nonce must be 32 lowercase hex characters");
  }
  return response.includes(nonce) || FENCE_MARKER.test(response);
}
