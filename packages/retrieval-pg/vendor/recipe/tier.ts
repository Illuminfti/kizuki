import type { RetrievalAuthority } from "@kizuki/core";

/**
 * Kizuki adaptation of the compiled-truth boost in the public tip's
 * hybrid fusion. Upstream multiplies compiled_truth chunks by 2.0 after
 * RRF normalization. Kizuki maps that privilege onto owner_correction
 * and keeps the remaining authority ladder as ranking weights. Path
 * prefixes from the upstream source-boost map are not used.
 */
export const AUTHORITY_WEIGHT: Readonly<Record<RetrievalAuthority, number>> = {
  owner_correction: 2.0,
  owner_authored: 1.2,
  connector_evidence: 1.0,
  model_inference: 0.8,
};

export const AUTHORITY_RANK: Readonly<Record<RetrievalAuthority, number>> = {
  owner_correction: 0,
  owner_authored: 1,
  connector_evidence: 2,
  model_inference: 3,
};

export function authorityBoost(authority: RetrievalAuthority): number {
  return AUTHORITY_WEIGHT[authority];
}

export function isPrivilegedAuthority(authority: RetrievalAuthority): boolean {
  return authority === "owner_correction";
}
