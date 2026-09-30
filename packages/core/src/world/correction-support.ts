import type { ClaimMeaning, ClaimV2Semantic } from "../contracts/claim-v2";
import { CLAIM_MEANING_SCHEMA } from "../contracts/claim-v2";
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

/** The reason the writer cannot correct a claim of this meaning, or null when it can. */
export function unsupportedCorrectionReason(
  meaning: ClaimV2Semantic | ClaimMeaning,
): UnsupportedAssertionReason | null {
  if (meaning.schema !== CLAIM_MEANING_SCHEMA || meaning.discriminator !== "assertion") return "not_an_assertion";
  if (meaning.predicate === WORLD_KIND_PREDICATE) return "classification_claim";
  const perspective = meaning.perspective;
  if (
    perspective.mode === "quoted" || perspective.mode === "reported" ||
    perspective.holder !== null || perspective.speaker !== null || perspective.addressee !== null
  ) return "quoted_attribution";
  return null;
}
