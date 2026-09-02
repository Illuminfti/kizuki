export { AUTHORITY_TIERS } from "../contracts/proposal";
export type {
  AuthorityTier,
  CanonicalProducer,
  Claim,
  ClaimKind,
  ClaimPolarity,
  ClaimStatus,
  ClaimTaint,
} from "../contracts/proposal";
export {
  CLAIM_KINDS,
  CLAIM_SCHEMA,
  CLAIM_STATUSES,
  canonicalizeProducer,
  isAuthorityTier,
  isClaimKind,
  isClaimStatus,
  isProducer,
  validateClaim,
} from "../contracts/proposal";

export {
  SINGLE_SOURCE_CAP,
  authorityFor,
} from "./authority";
export type { AuthorityAssignment, AuthorityDraft, EventFacts } from "./authority";

export {
  CONFLICT_MARGIN,
  claimsConflict,
  resolveConflict,
  validityOverlaps,
} from "./conflict";
export type { ConflictClaim, ConflictRule, Resolution } from "./conflict";

export {
  CLAIM_DEDUP_MIN,
  FIXTURE_EMBEDDING_SPACE,
  retrievalDedupMode,
  scoreClaimPair,
} from "./dedup";
export type { DedupMode } from "./dedup";

export { ClaimError } from "./errors";
export { claimKey, hashBody, normalizeObject } from "./hash";
export {
  PREDICATE_REGISTRY,
  getPredicate,
  isRegisteredPredicate,
  isSingleValuedPredicate,
  predicateIds,
} from "./predicates";
export type { PredicateCardinality, PredicateSpec } from "./predicates";
export { CLAIMS_SCHEMA_VERSION, applyClaimsV3, initClaims } from "./schema";
export {
  getClaim,
  insertClaim,
  listClaims,
  listSupersessions,
  markClaimsPurged,
} from "./store";
export type { ClaimsIo, InsertClaimInput, InsertClaimResult } from "./store";
