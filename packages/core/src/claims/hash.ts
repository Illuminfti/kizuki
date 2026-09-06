import type { ClaimPolarity } from "../contracts/proposal";

/** sha256(subject ‖ 0x00 ‖ predicate) — the conflict key (RFC 0002 §4.3, §5.2). */
export function claimKey(subject: string, predicate: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(subject)
    .update("\0")
    .update(predicate)
    .digest("hex");
}

export function hashBody(body: string): string {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex");
}

/**
 * RFC claim content signature (issues #167/#168). Provenance is not in the
 * key: a later sighting with the same semantic fields corroborates the live
 * row instead of forking it or being discarded. Sensitivity, taint, and
 * authority ride on the row and refine upward; they are not identity.
 */
const SIGNATURE_IGNORE_FRONTMATTER = new Set([
  "x-source-record-id",
  "x-capture-kind",
  "x-display-name",
]);

export function contentSignature(parts: {
  kind: string;
  target: string | null;
  body: string;
  frontmatter: Record<string, unknown>;
  subjects: readonly string[];
  producer: string;
  confidence: number;
}): string {
  const frontmatter = Object.fromEntries(
    Object.entries(parts.frontmatter)
      .filter(([key]) => !SIGNATURE_IGNORE_FRONTMATTER.has(key))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return hashBody(
    JSON.stringify([
      parts.kind,
      parts.target ?? "",
      parts.body,
      frontmatter,
      [...parts.subjects].sort(),
      parts.producer,
      parts.confidence,
    ]),
  );
}

/**
 * Casefold, collapse whitespace, strip terminal punctuation (RFC 0002 §4.3).
 */
export function normalizeObject(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\p{P}\p{S}]+$/u, "")
    .trim();
}

export function objectsMatch(
  left: string | null,
  right: string | null,
): boolean {
  if (left === null || right === null) return left === right;
  return normalizeObject(left) === normalizeObject(right);
}

export function polaritiesConflict(
  left: ClaimPolarity,
  right: ClaimPolarity,
): boolean {
  return left !== right;
}
