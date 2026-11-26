import type { ClaimMeaning, ClaimV2Semantic } from "../contracts/claim-v2";
import type { Relation } from "../contracts/world-card-kit";
import { WORLD_KIND_PREDICATE } from "../contracts/world-kinds";

/**
 * Why the correction writer cannot handle a world claim. This is the one
 * answer: the writer refuses with it and the owner's target list marks the same
 * claim unsupported with it. Every value is documented in docs/world/correct.md.
 */
export const UNSUPPORTED_ASSERTION_REASONS = Object.freeze({
  classification_claim:
    "a world.kind claim classifies its subject, and a second classification contradicts the first while it is live",
  not_an_assertion: "the claim's meaning is not a plain assertion",
  quoted_attribution:
    "the claim is quoted or reported, or names a holder, speaker or addressee; the owner's statement cannot replace that perspective's words",
});
export type UnsupportedAssertionReason = keyof typeof UNSUPPORTED_ASSERTION_REASONS;

export type CorrectionModeHint =
  | "replace_object"
  | "retract"
  | "reclassify_mode"
  | "merge_identity"
  | "separate_identity";

export interface AdaptiveDomainCorrectionPolicy {
  readonly supported: boolean;
  readonly unsupportedReason: UnsupportedAssertionReason | null;
  readonly allowedModes: readonly CorrectionModeHint[];
  readonly supersedesInterest: boolean;
  readonly requiresReceiptedUndo: true;
  readonly preservesSourceEvidence: true;
}

/** The reason the writer cannot correct a claim of this meaning, or null when it can. */
export function unsupportedCorrectionReason(
  meaning: ClaimV2Semantic | ClaimMeaning,
): UnsupportedAssertionReason | null {
  if (meaning.discriminator !== "assertion") return "not_an_assertion";
  if (meaning.predicate === WORLD_KIND_PREDICATE) return "classification_claim";
  const perspective = meaning.perspective;
  if (
    perspective.mode === "quoted" || perspective.mode === "reported" ||
    perspective.holder !== null || perspective.speaker !== null || perspective.addressee !== null
  ) return "quoted_attribution";
  return null;
}

/** True when an owner or authorized owner relay can retract this assertion through the shared writer. */
export function canOwnerRetractClaim(meaning: ClaimV2Semantic | ClaimMeaning): boolean {
  return unsupportedCorrectionReason(meaning) === null &&
    meaning.discriminator === "assertion" &&
    meaning.polarity === "positive";
}

/** Describe allowed correction modes and adaptive-domain effects from the single writer rule. */
export function describeCorrectionSupport(
  meaning: ClaimV2Semantic | ClaimMeaning,
): AdaptiveDomainCorrectionPolicy {
  const unsupportedReason = unsupportedCorrectionReason(meaning);
  if (unsupportedReason === "classification_claim") {
    const isConceptClassification =
      meaning.discriminator === "assertion" &&
      meaning.object.kind === "vocabulary" &&
      meaning.object.ref.id === "world/concept";
    return {
      supported: false,
      unsupportedReason,
      allowedModes: isConceptClassification ? ["merge_identity", "separate_identity"] : [],
      supersedesInterest: false,
      requiresReceiptedUndo: true,
      preservesSourceEvidence: true,
    };
  }
  if (unsupportedReason !== null || meaning.discriminator !== "assertion") {
    return {
      supported: false,
      unsupportedReason: unsupportedReason ?? "not_an_assertion",
      allowedModes: [],
      supersedesInterest: false,
      requiresReceiptedUndo: true,
      preservesSourceEvidence: true,
    };
  }
  const allowedModes: CorrectionModeHint[] = ["replace_object"];
  if (meaning.polarity === "positive") allowedModes.push("retract");
  allowedModes.push("reclassify_mode");
  return {
    supported: true,
    unsupportedReason: null,
    allowedModes,
    supersedesInterest: meaning.predicate === "person.interest" && meaning.polarity === "positive",
    requiresReceiptedUndo: true,
    preservesSourceEvidence: true,
  };
}

/** True when an authorized negative owner assertion supersedes a source-derived interest hypothesis. */
export function isOwnerInterestRetraction(
  relation: Pick<Relation, "predicate" | "polarity" | "assessments">,
): boolean {
  return relation.predicate === "person.interest" &&
    relation.polarity === "negative" &&
    relation.assessments.some(assessment => assessment.epistemicKind === "owner_assertion");
}
