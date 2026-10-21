import type { ClaimV2Assertion, RawSubjectRef } from "../contracts/claim-v2";
import { canonicalJson, sha256Hex } from "../util/hash";

/** A stable local reference without exposing connector IDs or source namespaces. */
const record = (ref: RawSubjectRef): string => `record ${sha256Hex(canonicalJson(ref))}`;

/**
 * Render only the admitted assertion. Source prose can describe several facts;
 * repeating it for each slot would resurrect a superseded fact through its
 * still-live label or classification. The untouched admission retains evidence.
 * This version is frozen by each receipt's rendering discriminator.
 */
export function renderWorldAssertion(semantic: ClaimV2Assertion): string {
  const object = semantic.object.kind === "literal" ? semantic.object.value
    : semantic.object.kind === "vocabulary" ? semantic.object.ref.id : record(semantic.object.ref);
  const perspective = semantic.perspective;
  const qualifiers = [semantic.polarity, perspective.mode, `${perspective.interpretation} interpretation`];
  for (const role of ["holder", "speaker", "addressee"] as const) {
    if (perspective[role] !== null) qualifiers.push(`${role}: ${record(perspective[role])}`);
  }
  if (semantic.context.length > 0) qualifiers.push(`context: ${semantic.context.map(record).join(", ")}`);
  qualifiers.push(`valid from ${semantic.valid_from ?? "unknown"} until ${semantic.valid_to ?? "unknown"}`,
    `${semantic.temporal_basis} time basis`);
  return `${semantic.predicate}: ${object}\n(${qualifiers.join("; ")})`;
}
