import type { AuthorityTier, Claim, ClaimPolarity } from "../contracts/proposal";
import { AUTHORITY_TIERS } from "../contracts/proposal";
import { objectsMatch, polaritiesConflict } from "./hash";
import { isSingleValuedPredicate } from "./predicates";

export const CONFLICT_MARGIN = 0.15;

export type ConflictRule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export type Resolution =
  | {
      action: "supersede";
      winner: "incoming" | "live";
      rule: Exclude<ConflictRule, "R2" | "R4">;
    }
  | { action: "skip"; reason: "below_authority"; rule: "R1" | "R2" }
  | { action: "contested"; rule: "R4" };

export interface ConflictClaim {
  readonly claim_id: string;
  readonly claim_key: string | null;
  readonly polarity: ClaimPolarity;
  readonly object: string | null;
  readonly predicate: string | null;
  readonly authority: AuthorityTier;
  readonly confidence: number;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly status: Claim["status"];
  readonly provenance: readonly string[];
  readonly purged?: boolean;
}

export function validityOverlaps(
  left: { valid_from: string; valid_to: string | null },
  right: { valid_from: string; valid_to: string | null },
): boolean {
  const leftEnd = left.valid_to ?? "\uFFFF";
  const rightEnd = right.valid_to ?? "\uFFFF";
  return left.valid_from < rightEnd && right.valid_from < leftEnd;
}

/**
 * Two live claims conflict when they share a claim_key, overlap in validity,
 * and have incompatible values (RFC 0002 §5.2).
 */
export function claimsConflict(left: ConflictClaim, right: ConflictClaim): boolean {
  if (left.claim_key === null || left.claim_key !== right.claim_key) return false;
  if (!validityOverlaps(left, right)) return false;
  if (polaritiesConflict(left.polarity, right.polarity)) return true;
  if (
    left.predicate !== null &&
    isSingleValuedPredicate(left.predicate) &&
    !objectsMatch(left.object, right.object)
  ) {
    return true;
  }
  return false;
}

function laterWins(incoming: ConflictClaim, live: ConflictClaim): "incoming" | "live" {
  if (incoming.valid_from !== live.valid_from) {
    return incoming.valid_from > live.valid_from ? "incoming" : "live";
  }
  if (incoming.confidence !== live.confidence) {
    return incoming.confidence > live.confidence ? "incoming" : "live";
  }
  return incoming.claim_id > live.claim_id ? "incoming" : "live";
}

function sameTierResolution(
  incoming: ConflictClaim,
  live: ConflictClaim,
  allowMargin: boolean,
): Resolution {
  const winner = laterWins(incoming, live);
  const loser = winner === "incoming" ? live : incoming;
  const winnerClaim = winner === "incoming" ? incoming : live;
  const margin = winnerClaim.confidence - loser.confidence;
  if (
    allowMargin &&
    AUTHORITY_TIERS[incoming.authority] <= 2 &&
    AUTHORITY_TIERS[live.authority] <= 2 &&
    margin >= 0 &&
    margin < CONFLICT_MARGIN
  ) {
    return { action: "contested", rule: "R4" };
  }
  return { action: "supersede", winner, rule: "R3" };
}

export function resolveConflict(
  incoming: ConflictClaim,
  live: ConflictClaim,
): Resolution {
  if (live.status === "purged" || live.purged === true) {
    return { action: "supersede", winner: "incoming", rule: "R6" };
  }

  if (incoming.authority === "owner_correction") {
    if (live.authority === "owner_correction") {
      return sameTierResolution(incoming, live, false);
    }
    return { action: "supersede", winner: "incoming", rule: "R5" };
  }

  if (live.authority === "owner_correction") {
    return { action: "skip", reason: "below_authority", rule: "R1" };
  }

  if (
    incoming.authority === "model_inference" &&
    AUTHORITY_TIERS[live.authority] >= 2
  ) {
    return { action: "skip", reason: "below_authority", rule: "R2" };
  }

  if (AUTHORITY_TIERS[incoming.authority] > AUTHORITY_TIERS[live.authority]) {
    return { action: "supersede", winner: "incoming", rule: "R1" };
  }
  if (AUTHORITY_TIERS[incoming.authority] < AUTHORITY_TIERS[live.authority]) {
    return { action: "skip", reason: "below_authority", rule: "R1" };
  }

  return sameTierResolution(incoming, live, true);
}
