import { canonicalJson } from "../util/hash";
import {
  CLAIM_V2_SNAPSHOT_LIMITS,
  isQualifiedRawSubjectRef,
  rawSubjectRefKey,
  type RawSubjectRef,
  validateClaimV2Semantic,
  type ClaimV2Assertion,
} from "./claim-v2";
import {
  isAuthorityTier,
  type AuthorityTier,
  type FrontmatterValue,
} from "./proposal";
import { cloneExactJson, isPlainObject } from "../util/validate";
import { isUlid } from "../util/ulid";
import type { ConceptEpistemicKind } from "./concept-card";

export const WORLD_ADMISSION_SCHEMA = "kizuki.world-admission/v1" as const;
export const WORLD_GROUNDED_ADMISSION_SCHEMA = "kizuki.world-admission/v2" as const;
/** Durable pins to existing source admissions, never request-local model handles. */
export type WorldGroundingPin = { readonly claim_id: string; readonly support_key: string; readonly admission_hash: string; readonly events: readonly { readonly event_id: string; readonly event_content_hash: string }[] };
export type WorldGrounding = {
  readonly endpoint: RawSubjectRef;
  readonly classification: WorldGroundingPin;
  readonly label: WorldGroundingPin;
};
/** Original, support-specific rendering. No body or metadata from legacy admissions is authority. */
type WorldAdmissionBody = {
  readonly semantic: ClaimV2Assertion;
  readonly rendering: {
    readonly body: string;
    readonly frontmatter: Readonly<Record<string, FrontmatterValue>>;
  };
  readonly authority: AuthorityTier;
  readonly confidence: number;
  readonly epistemicKind: ConceptEpistemicKind;
};
export type WorldAdmission = WorldAdmissionBody & (
  | { readonly schema: typeof WORLD_ADMISSION_SCHEMA }
  | { readonly schema: typeof WORLD_GROUNDED_ADMISSION_SCHEMA; readonly grounding: readonly WorldGrounding[] }
);
/** v2 is deliberately limited to asserted binary identity, never owner authority. */
export function isGroundedIdentity(semantic: ClaimV2Assertion): boolean {
  return ["concept.same_as", "concept.distinguished_from"].includes(semantic.predicate) &&
    semantic.object.kind === "subject" && rawSubjectRefKey(semantic.subject) !== rawSubjectRefKey(semantic.object.ref) &&
    semantic.context.length === 0 && semantic.perspective.mode === "asserted" &&
    semantic.perspective.holder === null && semantic.perspective.speaker === null && semantic.perspective.addressee === null;
}
function groundingPins(value: unknown, semantic: ClaimV2Assertion): readonly WorldGrounding[] | null {
  if (!isGroundedIdentity(semantic) || semantic.object.kind !== "subject" || !Array.isArray(value) || value.length !== 2) return null;
  const endpoints = [semantic.subject, semantic.object.ref].sort((a, b) => rawSubjectRefKey(a) < rawSubjectRefKey(b) ? -1 : 1);
  const pin = (v: unknown): boolean => isPlainObject(v) && Object.keys(v).sort().join(",") === "admission_hash,claim_id,events,support_key" &&
    typeof v.claim_id === "string" && isUlid(v.claim_id) && typeof v.support_key === "string" && /^[a-f0-9]{64}$/.test(v.support_key) &&
    typeof v.admission_hash === "string" && /^[a-f0-9]{64}$/.test(v.admission_hash) &&
    Array.isArray(v.events) && v.events.length > 0 && v.events.length <= 4 && v.events.every((e, i) =>
      isPlainObject(e) && Object.keys(e).sort().join(",") === "event_content_hash,event_id" &&
      typeof e.event_id === "string" && isUlid(e.event_id) && typeof e.event_content_hash === "string" && /^[a-f0-9]{64}$/.test(e.event_content_hash) &&
      (i === 0 || (v.events as { event_id: string }[])[i - 1]!.event_id < e.event_id));
  for (let i = 0; i < value.length; i++) {
    const proof = value[i];
    if (!isPlainObject(proof) || Object.keys(proof).sort().join(",") !== "classification,endpoint,label" ||
        canonicalJson(proof.endpoint) !== canonicalJson(endpoints[i]) ||
        !pin(proof.classification) || !pin(proof.label)) return null;
  }
  return value as unknown as readonly WorldGrounding[];
}
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
    Object.keys(input).length !== (input.schema === WORLD_GROUNDED_ADMISSION_SCHEMA ? 7 : 6) ||
    (input.schema !== WORLD_ADMISSION_SCHEMA && input.schema !== WORLD_GROUNDED_ADMISSION_SCHEMA) ||
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
  const grounding = input.schema === WORLD_GROUNDED_ADMISSION_SCHEMA ? groundingPins(input.grounding, assertion) : null;
  if (input.schema === WORLD_GROUNDED_ADMISSION_SCHEMA &&
      (grounding === null || input.authority !== "model_inference" || input.epistemicKind !== "model_inference")) return null;
  return {
    ...(input.schema === WORLD_GROUNDED_ADMISSION_SCHEMA
      ? { schema: WORLD_GROUNDED_ADMISSION_SCHEMA, grounding: grounding! }
      : { schema: WORLD_ADMISSION_SCHEMA }),
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
