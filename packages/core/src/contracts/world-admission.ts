import {
  CLAIM_V2_SNAPSHOT_LIMITS,
  isQualifiedRawSubjectRef,
  validateClaimV2Semantic,
  type ClaimV2Assertion,
} from "./claim-v2";
import {
  isAuthorityTier,
  type AuthorityTier,
  type FrontmatterValue,
} from "./proposal";
import { cloneExactJson, isPlainObject } from "../util/validate";
import type { ConceptEpistemicKind } from "./concept-card";

export const WORLD_ADMISSION_SCHEMA = "kizuki.world-admission/v1" as const;
/** Original, support-specific rendering. No body or metadata from legacy admissions is authority. */
export type WorldAdmission = {
  readonly schema: typeof WORLD_ADMISSION_SCHEMA;
  readonly semantic: ClaimV2Assertion;
  readonly rendering: {
    readonly body: string;
    readonly frontmatter: Readonly<Record<string, FrontmatterValue>>;
  };
  readonly authority: AuthorityTier;
  readonly confidence: number;
  readonly epistemicKind: ConceptEpistemicKind;
};
const KINDS = new Set<ConceptEpistemicKind>([
  "observed",
  "reported",
  "owner_assertion",
  "model_inference",
  "hypothesis",
  "recommendation",
  "scenario",
]);
export function parseWorldAdmission(input: unknown): WorldAdmission | null {
  const errors: string[] = [];
  try {
    input = cloneExactJson(
      input,
      "world_admission",
      CLAIM_V2_SNAPSHOT_LIMITS,
      errors,
    );
  } catch {
    return null;
  }
  if (errors.length > 0) return null;
  if (
    !isPlainObject(input) ||
    Object.keys(input).length !== 6 ||
    input.schema !== WORLD_ADMISSION_SCHEMA ||
    !isAuthorityTier(input.authority) ||
    typeof input.confidence !== "number" ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1 ||
    !KINDS.has(input.epistemicKind as ConceptEpistemicKind)
  )
    return null;
  if (
    !isPlainObject(input.rendering) ||
    Object.keys(input.rendering).length !== 2 ||
    typeof input.rendering.body !== "string" ||
    input.rendering.body.length > 1200 ||
    !isPlainObject(input.rendering.frontmatter) ||
    Object.keys(input.rendering.frontmatter).length > 16
  )
    return null;
  const scalar = (value: unknown): value is string | number | boolean =>
    (typeof value === "string" && value.length <= 1200) ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
  if (
    !Object.values(input.rendering.frontmatter).every(
      (value) =>
        scalar(value) ||
        (Array.isArray(value) && value.length <= 16 && value.every(scalar)),
    )
  )
    return null;
  const semantic = validateClaimV2Semantic(input.semantic);
  if (!semantic.ok || semantic.value.discriminator !== "assertion") return null;
  const assertion = semantic.value;
  const refs = [
    assertion.subject,
    ...(assertion.object.kind === "subject" ? [assertion.object.ref] : []),
    ...assertion.context,
    assertion.perspective.holder,
    assertion.perspective.speaker,
    assertion.perspective.addressee,
  ];
  if (!refs.every((ref) => ref === null || isQualifiedRawSubjectRef(ref)))
    return null;
  return {
    schema: WORLD_ADMISSION_SCHEMA,
    semantic: semantic.value,
    rendering: {
      body: input.rendering.body,
      frontmatter: structuredClone(input.rendering.frontmatter) as Record<
        string,
        FrontmatterValue
      >,
    },
    authority: input.authority,
    confidence: input.confidence,
    epistemicKind: input.epistemicKind as ConceptEpistemicKind,
  };
}

/** Canonical bounded union used by writer, key calculation and projector. */
export function completeWorldAnchors(
  semantic: ClaimV2Assertion,
): ClaimV2Assertion["anchors"] {
  return [
    ...new Map(
      [...semantic.anchors, ...semantic.perspective.anchors].map((anchor) => [
        `${anchor.event_id}:${anchor.start_utf16}:${anchor.end_utf16}`,
        anchor,
      ]),
    ).values(),
  ].sort(
    (a, b) =>
      a.event_id.localeCompare(b.event_id) ||
      a.start_utf16 - b.start_utf16 ||
      a.end_utf16 - b.end_utf16,
  );
}
