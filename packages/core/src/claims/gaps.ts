import type { Database } from "bun:sqlite";
import type { Claim } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { isSingleValuedPredicate } from "./predicates";
import { listClaims } from "./store";

export interface ValidityGap {
  readonly claim_key: string;
  readonly predicate: string | null;
  readonly after: string;
  readonly before: string;
}

/**
 * Holes in a single-valued claim_key's validity coverage. Overlapping
 * live peers are conflicts (listLiveConflicts); a gap is the inverse.
 */
export function listValidityGaps(
  db: Database,
  opts: { subject?: string; limit?: number; canRead?: (claim: Claim) => boolean } = {},
): ValidityGap[] {
  if (!tableExists(db, "claims")) return [];
  const bound =
    Number.isSafeInteger(opts.limit) && (opts.limit ?? 0) > 0
      ? (opts.limit as number)
      : 32;
  const candidates = listClaims(db, {
    keyed: true,
    ...(opts.subject === undefined ? {} : { subject: opts.subject }),
    limit: 401,
  });
  // A partial history cannot prove an absence: later rows may fill the hole.
  if (candidates.length > 400) return [];
  const rows = candidates.filter(
    (claim) =>
      claim.claim_key !== null &&
      claim.predicate !== null &&
      isSingleValuedPredicate(claim.predicate) &&
      (claim.status === "live" || claim.status === "superseded"),
  );
  const byKey = new Map<string, typeof rows>();
  for (const claim of rows) {
    if (claim.claim_key === null) continue;
    const group = byKey.get(claim.claim_key) ?? [];
    group.push(claim);
    byKey.set(claim.claim_key, group);
  }
  const gaps: ValidityGap[] = [];
  for (const [claim_key, group] of byKey) {
    // Removing hidden intervals would invent a gap. Withhold the whole
    // derived assertion unless every interval used to compute it is visible.
    if (opts.canRead !== undefined && !group.every(opts.canRead)) continue;
    const ordered = [...group].sort((left, right) =>
      left.valid_from < right.valid_from
        ? -1
        : left.valid_from > right.valid_from
          ? 1
          : left.claim_id < right.claim_id
            ? -1
            : 1,
    );
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const current = ordered[index];
      const next = ordered[index + 1];
      if (current === undefined || next === undefined) continue;
      if (current.valid_to === null) continue;
      if (current.valid_to < next.valid_from) {
        gaps.push({
          claim_key,
          predicate: current.predicate,
          after: current.valid_to,
          before: next.valid_from,
        });
        if (gaps.length >= bound) return gaps;
      }
    }
  }
  return gaps;
}
