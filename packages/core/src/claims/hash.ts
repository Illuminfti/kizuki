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
