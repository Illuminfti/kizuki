import type { Claim, ClaimPolarity } from "../contracts/proposal";
import { normalizeObject } from "../claims/hash";
import type { CorrectTarget } from "./types";

/**
 * Deterministic object/polarity for a `--claim` correction. This is not a
 * model producer: it only reads the targeted claim plus a few replacement
 * patterns so `kizuki tell --claim` works with zero models configured.
 */
export function objectFromStatement(
  statement: string,
  live: Claim,
): { object: string; polarity: ClaimPolarity } {
  const atReplacement = statement.match(/\bat\s+(\S+)(?:\s+now)?\s*,\s*not\s+/i);
  if (atReplacement?.[1] !== undefined) {
    return { object: normalizeObject(atReplacement[1]), polarity: "positive" };
  }
  const nowNot = statement.match(/\bis\s+(\S+)(?:\s+now)?\s*,\s*not\s+/i);
  if (nowNot?.[1] !== undefined) {
    return { object: normalizeObject(nowNot[1]), polarity: "positive" };
  }
  return { object: normalizeObject(statement), polarity: live.polarity };
}

export function targetJson(target: CorrectTarget | undefined): string {
  if (target === undefined) return "{}";
  const keys = ["claim_id", "page_id", "subject", "claim_key"] as const;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = target[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return JSON.stringify(out);
}

export function sourceRecordId(statement: string, target: CorrectTarget | undefined): string {
  return new Bun.CryptoHasher("sha256")
    .update(statement)
    .update("\0")
    .update(targetJson(target))
    .digest("hex");
}

export function hasExactTarget(target: CorrectTarget | undefined): boolean {
  if (target === undefined) return false;
  return (
    (typeof target.claim_id === "string" && target.claim_id.length > 0) ||
    (typeof target.claim_key === "string" && target.claim_key.length > 0)
  );
}
