import type { Database } from "bun:sqlite";
import { compareRfc3339 } from "../agents/time";
import { tableExists } from "../ledger/schema";
import { readClaimGroups, type ClaimGroupOptions } from "./read-groups";

export interface ValidityGap {
  readonly claim_key: string;
  readonly predicate: string | null;
  readonly after: string;
  readonly before: string;
}

/**
 * Holes in a single-valued claim_key's readable validity coverage. Overlapping
 * live peers are conflicts (listLiveConflicts); a gap is the inverse.
 */
export function listValidityGaps(
  db: Database,
  opts: ClaimGroupOptions & { limit?: number } = {},
): ValidityGap[] {
  if (!tableExists(db, "claims")) return [];
  const bound =
    Number.isSafeInteger(opts.limit) && (opts.limit ?? 0) > 0
      ? (opts.limit as number)
      : 32;
  const gaps: ValidityGap[] = [];
  for (const group of readClaimGroups(db, opts, "gaps")) {
    const claim_key = group[0]!.claim_key!;
    const ordered = [...group].sort((left, right) => {
      const recency = compareRfc3339(
        left.valid_from,
        "valid_from",
        right.valid_from,
        "valid_from",
      );
      if (recency !== 0) return recency;
      return left.claim_id < right.claim_id
        ? -1
        : left.claim_id > right.claim_id
          ? 1
          : 0;
    });
    let coveredUntil = ordered[0]!.valid_to;
    const keyGaps: ValidityGap[] = [];
    for (const next of ordered.slice(1)) {
      if (coveredUntil === null) break;
      if (compareRfc3339(coveredUntil, "valid_to", next.valid_from, "valid_from") < 0) {
        keyGaps.push({
          claim_key,
          predicate: next.predicate,
          after: coveredUntil,
          before: next.valid_from,
        });
      }
      if (
        next.valid_to === null ||
        compareRfc3339(next.valid_to, "valid_to", coveredUntil, "valid_to") > 0
      )
        coveredUntil = next.valid_to;
    }
    gaps.push(...keyGaps.reverse().slice(0, bound - gaps.length));
    if (gaps.length >= bound) return gaps;
  }
  return gaps;
}
