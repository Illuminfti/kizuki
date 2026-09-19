import { compareRfc3339 } from "../agents/time";
import { isVisibleIdentifier } from "../util/opaque-identifier";
import { isRfc3339 } from "../util/time";
import { cloneExactJson, isPlainObject, utf8ByteLength } from "../util/validate";
import type { ExactJsonLimits } from "../util/validate";
import { isAuthorityTier } from "./proposal";
import type { AuthorityTier } from "./proposal";

export const SITUATION_CARD_SCHEMA = "kizuki.situation-card/v1" as const;
export const SITUATION_NODE_SCHEMA = "kizuki.knowledge-node/v1" as const;
export const SITUATION_RELATION_SCHEMA = "kizuki.relation/v1" as const;

export type SituationWireKind =
  | "object"
  | "claim"
  | "admission"
  | "event_version"
  | "snapshot";
export type SituationWireRef<K extends SituationWireKind = SituationWireKind> = {
  readonly kind: K;
  readonly token: string;
};

type KnownTime =
  | { readonly kind: "known"; readonly from: string; readonly until: string | null }
  | { readonly kind: "unknown" };

export type SituationEvidenceSpan =
  | { readonly kind: "text"; readonly startUtf16: number; readonly endUtf16: number }
  | { readonly kind: "metadata"; readonly field: string };

export type SituationEvidenceRef = {
  readonly admission: SituationWireRef<"admission">;
  readonly eventVersion: SituationWireRef<"event_version">;
  readonly span: SituationEvidenceSpan;
};

export type SituationPerspective = {
  readonly holder: SituationWireRef<"object"> | null;
  readonly speaker: SituationWireRef<"object"> | null;
  readonly addressee: SituationWireRef<"object"> | null;
  readonly mode:
    | "asserted"
    | "quoted"
    | "reported"
    | "hypothetical"
    | "suggested"
    | "questioned"
    | "uncertain";
  readonly interpretation: "explicit" | "inferred";
  readonly evidence: readonly SituationEvidenceRef[];
};

export type SituationConfidence =
  | { readonly kind: "known"; readonly value: number }
  | { readonly kind: "unknown" };

export type SituationEpistemicKind =
  | "observed"
  | "reported"
  | "owner_assertion"
  | "model_inference"
  | "hypothesis"
  | "recommendation"
  | "scenario";

export type SituationAdmissionAssessment = {
  readonly admission: SituationWireRef<"admission">;
  readonly epistemicKind: SituationEpistemicKind;
  readonly authority: AuthorityTier;
  readonly confidence: SituationConfidence;
  readonly independence: "independent" | "dependent" | "unknown";
  readonly evidence: readonly SituationEvidenceRef[];
};

export type SituationRelationObject =
  | { readonly kind: "node"; readonly ref: SituationWireRef<"object"> }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "vocabulary"; readonly id: string };

export type SituationRelation = {
  readonly schema: typeof SITUATION_RELATION_SCHEMA;
  readonly claim: SituationWireRef<"claim">;
  readonly subject: SituationWireRef<"object">;
  readonly predicate: string;
  readonly object: SituationRelationObject;
  readonly perspective: SituationPerspective;
  readonly context: readonly SituationWireRef<"object">[];
  readonly polarity: "positive" | "negative";
  readonly valid: KnownTime;
  readonly temporalBasis: "explicit" | "observed" | "unknown";
  readonly assessments: readonly SituationAdmissionAssessment[];
  readonly conflict: "none_observed" | "present" | "unknown";
};

export type SituationNode = {
  readonly schema: typeof SITUATION_NODE_SCHEMA;
  readonly ref: SituationWireRef<"object">;
  readonly kind: "situation";
  readonly classificationClaims: readonly SituationWireRef<"claim">[];
  readonly labels: readonly {
    readonly text: string;
    readonly claim: SituationWireRef<"claim">;
  }[];
  readonly resolution: "distinct" | "resolved" | "ambiguous";
};

export type SituationValidQuery =
  | { readonly kind: "all" }
  | { readonly kind: "at"; readonly at: string }
  | { readonly kind: "overlap"; readonly from: string; readonly until: string }
  | { readonly kind: "unknown_only" };

export type SituationViewGap =
  | "coverage"
  | "pending_consolidation"
  | "stale_dependencies"
  | "required_context_overflow"
  | "traversal_limit";

export type SituationCoverage = {
  readonly status: "complete_for_query" | "partial";
  readonly gaps: readonly SituationViewGap[];
  readonly validWindow: SituationValidQuery;
  readonly history: "retained_for_query" | "baseline_only" | "unavailable";
};

export type SituationCard = {
  readonly schema: typeof SITUATION_CARD_SCHEMA;
  readonly situation: SituationNode;
  readonly summary: {
    readonly text: string;
    readonly admissions: readonly SituationWireRef<"admission">[];
  } | null;
  readonly objective: SituationRelation | null;
  readonly participants: readonly SituationWireRef<"object">[];
  readonly commitments: readonly SituationRelation[];
  readonly blocker: SituationRelation | null;
  readonly recentChange: SituationRelation | null;
  readonly uncertainty: readonly SituationRelation[];
  readonly knownAt:
    | { readonly kind: "current" }
    | { readonly kind: "snapshot"; readonly ref: SituationWireRef<"snapshot"> };
  readonly coverage: SituationCoverage;
};

export type SituationCardValidationResult =
  | { readonly ok: true; readonly value: SituationCard }
  | { readonly ok: false; readonly errors: readonly ["invalid situation-card/v1 payload"] };

const WIRE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MODES = new Set<SituationPerspective["mode"]>([
  "asserted",
  "quoted",
  "reported",
  "hypothetical",
  "suggested",
  "questioned",
  "uncertain",
]);
const EPISTEMIC = new Set<SituationEpistemicKind>([
  "observed",
  "reported",
  "owner_assertion",
  "model_inference",
  "hypothesis",
  "recommendation",
  "scenario",
]);
const GAPS = new Set<SituationViewGap>([
  "coverage",
  "pending_consolidation",
  "stale_dependencies",
  "required_context_overflow",
  "traversal_limit",
]);
const SNAPSHOT_LIMITS: ExactJsonLimits = {
  maxDepth: 12,
  maxKeysPerObject: 16,
  maxArrayLength: 256,
  maxStringBytes: 1200,
  maxKeyBytes: 64,
  maxTotalBytes: 262144,
};
const INVALID: SituationCardValidationResult = Object.freeze({
  ok: false,
  errors: Object.freeze(["invalid situation-card/v1 payload"] as const),
});

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function wireToken(value: unknown): value is string {
  if (typeof value !== "string" || !WIRE_TOKEN.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").byteLength === 32;
  } catch {
    return false;
  }
}

function wireRef<K extends SituationWireKind>(
  value: unknown,
  kind: K,
): value is SituationWireRef<K> {
  return (
    isPlainObject(value) &&
    exact(value, ["kind", "token"]) &&
    value.kind === kind &&
    wireToken(value.token)
  );
}

function optionalObjectRef(value: unknown): value is SituationWireRef<"object"> | null {
  return value === null || wireRef(value, "object");
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8ByteLength(value) <= maxBytes &&
    isVisibleIdentifier(value)
  );
}

function predicate(value: unknown): value is string {
  return typeof value === "string" && FIELD.test(value) && utf8ByteLength(value) <= 128;
}

function fieldName(value: unknown): value is string {
  return typeof value === "string" && FIELD.test(value) && utf8ByteLength(value) <= 128;
}

function knownTime(value: unknown): value is KnownTime {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "unknown") return exact(value, ["kind"]);
  if (value.kind !== "known" || !exact(value, ["kind", "from", "until"])) return false;
  if (!isRfc3339(value.from) || (value.until !== null && !isRfc3339(value.until))) {
    return false;
  }
  return value.until === null || compareRfc3339(value.until, "until", value.from, "from") > 0;
}

function span(value: unknown): value is SituationEvidenceSpan {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "text") {
    const start = value.startUtf16;
    const end = value.endUtf16;
    return (
      exact(value, ["kind", "startUtf16", "endUtf16"]) &&
      typeof start === "number" &&
      typeof end === "number" &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      end > start
    );
  }
  return value.kind === "metadata" && exact(value, ["kind", "field"]) && fieldName(value.field);
}

function evidenceRef(value: unknown): value is SituationEvidenceRef {
  return (
    isPlainObject(value) &&
    exact(value, ["admission", "eventVersion", "span"]) &&
    wireRef(value.admission, "admission") &&
    wireRef(value.eventVersion, "event_version") &&
    span(value.span)
  );
}

function evidenceList(value: unknown): value is readonly SituationEvidenceRef[] {
  return Array.isArray(value) && value.length <= 256 && value.every(evidenceRef);
}

function objectRefList(value: unknown): value is readonly SituationWireRef<"object">[] {
  return Array.isArray(value) && value.length <= 256 && value.every((item) => wireRef(item, "object"));
}

function claimRefList(value: unknown): value is readonly SituationWireRef<"claim">[] {
  return Array.isArray(value) && value.length <= 256 && value.every((item) => wireRef(item, "claim"));
}

function admissionRefList(value: unknown): value is readonly SituationWireRef<"admission">[] {
  return (
    Array.isArray(value) && value.length <= 256 && value.every((item) => wireRef(item, "admission"))
  );
}

function confidence(value: unknown): value is SituationConfidence {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "unknown") return exact(value, ["kind"]);
  return (
    value.kind === "known" &&
    exact(value, ["kind", "value"]) &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    value.value >= 0 &&
    value.value <= 1
  );
}

function assessment(value: unknown): value is SituationAdmissionAssessment {
  return (
    isPlainObject(value) &&
    exact(value, [
      "admission",
      "epistemicKind",
      "authority",
      "confidence",
      "independence",
      "evidence",
    ]) &&
    wireRef(value.admission, "admission") &&
    EPISTEMIC.has(value.epistemicKind as SituationEpistemicKind) &&
    isAuthorityTier(value.authority) &&
    confidence(value.confidence) &&
    (value.independence === "independent" ||
      value.independence === "dependent" ||
      value.independence === "unknown") &&
    evidenceList(value.evidence)
  );
}

function relationObject(value: unknown): value is SituationRelationObject {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "node") {
    return exact(value, ["kind", "ref"]) && wireRef(value.ref, "object");
  }
  if (value.kind === "literal") {
    return exact(value, ["kind", "value"]) && boundedText(value.value, 400);
  }
  return value.kind === "vocabulary" && exact(value, ["kind", "id"]) && predicate(value.id);
}

function perspective(value: unknown): value is SituationPerspective {
  return (
    isPlainObject(value) &&
    exact(value, [
      "holder",
      "speaker",
      "addressee",
      "mode",
      "interpretation",
      "evidence",
    ]) &&
    optionalObjectRef(value.holder) &&
    optionalObjectRef(value.speaker) &&
    optionalObjectRef(value.addressee) &&
    MODES.has(value.mode as SituationPerspective["mode"]) &&
    (value.interpretation === "explicit" || value.interpretation === "inferred") &&
    evidenceList(value.evidence)
  );
}

function relation(value: unknown): value is SituationRelation {
  if (
    !isPlainObject(value) ||
    !exact(value, [
      "schema",
      "claim",
      "subject",
      "predicate",
      "object",
      "perspective",
      "context",
      "polarity",
      "valid",
      "temporalBasis",
      "assessments",
      "conflict",
    ]) ||
    value.schema !== SITUATION_RELATION_SCHEMA ||
    !wireRef(value.claim, "claim") ||
    !wireRef(value.subject, "object") ||
    !predicate(value.predicate) ||
    !relationObject(value.object) ||
    !perspective(value.perspective) ||
    !objectRefList(value.context) ||
    (value.polarity !== "positive" && value.polarity !== "negative") ||
    !knownTime(value.valid) ||
    (value.temporalBasis !== "explicit" &&
      value.temporalBasis !== "observed" &&
      value.temporalBasis !== "unknown") ||
    !Array.isArray(value.assessments) ||
    value.assessments.length > 256 ||
    (value.conflict !== "none_observed" &&
      value.conflict !== "present" &&
      value.conflict !== "unknown")
  ) {
    return false;
  }
  return value.assessments.every(assessment);
}

function optionalRelation(value: unknown): value is SituationRelation | null {
  return value === null || relation(value);
}

function relationList(value: unknown): value is readonly SituationRelation[] {
  return Array.isArray(value) && value.length <= 256 && value.every(relation);
}

function situationNode(value: unknown): value is SituationNode {
  if (
    !isPlainObject(value) ||
    !exact(value, [
      "schema",
      "ref",
      "kind",
      "classificationClaims",
      "labels",
      "resolution",
    ]) ||
    value.schema !== SITUATION_NODE_SCHEMA ||
    !wireRef(value.ref, "object") ||
    value.kind !== "situation" ||
    !claimRefList(value.classificationClaims) ||
    !Array.isArray(value.labels) ||
    value.labels.length > 256 ||
    (value.resolution !== "distinct" &&
      value.resolution !== "resolved" &&
      value.resolution !== "ambiguous")
  ) {
    return false;
  }
  return value.labels.every(
    (item) =>
      isPlainObject(item) &&
      exact(item, ["text", "claim"]) &&
      boundedText(item.text, 400) &&
      wireRef(item.claim, "claim"),
  );
}

function validQuery(value: unknown): value is SituationValidQuery {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "all" || value.kind === "unknown_only") {
    return exact(value, ["kind"]);
  }
  if (value.kind === "at") {
    return exact(value, ["kind", "at"]) && isRfc3339(value.at);
  }
  if (value.kind !== "overlap" || !exact(value, ["kind", "from", "until"])) {
    return false;
  }
  return (
    isRfc3339(value.from) &&
    isRfc3339(value.until) &&
    compareRfc3339(value.until, "until", value.from, "from") > 0
  );
}

function coverage(value: unknown): value is SituationCoverage {
  return (
    isPlainObject(value) &&
    exact(value, ["status", "gaps", "validWindow", "history"]) &&
    (value.status === "complete_for_query" || value.status === "partial") &&
    Array.isArray(value.gaps) &&
    value.gaps.length <= 16 &&
    value.gaps.every((item) => typeof item === "string" && GAPS.has(item as SituationViewGap)) &&
    validQuery(value.validWindow) &&
    (value.history === "retained_for_query" ||
      value.history === "baseline_only" ||
      value.history === "unavailable")
  );
}

function summary(value: unknown): value is SituationCard["summary"] {
  if (value === null) return true;
  return (
    isPlainObject(value) &&
    exact(value, ["text", "admissions"]) &&
    boundedText(value.text, 1200) &&
    admissionRefList(value.admissions)
  );
}

function knownAt(value: unknown): value is SituationCard["knownAt"] {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "current") return exact(value, ["kind"]);
  return (
    value.kind === "snapshot" &&
    exact(value, ["kind", "ref"]) &&
    wireRef(value.ref, "snapshot")
  );
}

/** Snapshots untrusted JSON before validating a closed situation card. */
export function validateSituationCard(input: unknown): SituationCardValidationResult {
  try {
    const errors: string[] = [];
    const snapshot = cloneExactJson(input, "situation-card", SNAPSHOT_LIMITS, errors);
    if (
      snapshot === undefined ||
      !isPlainObject(snapshot) ||
      snapshot.schema !== SITUATION_CARD_SCHEMA ||
      !exact(snapshot, [
        "schema",
        "situation",
        "summary",
        "objective",
        "participants",
        "commitments",
        "blocker",
        "recentChange",
        "uncertainty",
        "knownAt",
        "coverage",
      ]) ||
      !situationNode(snapshot.situation) ||
      !summary(snapshot.summary) ||
      !optionalRelation(snapshot.objective) ||
      !objectRefList(snapshot.participants) ||
      !relationList(snapshot.commitments) ||
      !optionalRelation(snapshot.blocker) ||
      !optionalRelation(snapshot.recentChange) ||
      !relationList(snapshot.uncertainty) ||
      !knownAt(snapshot.knownAt) ||
      !coverage(snapshot.coverage)
    ) {
      return INVALID;
    }
    return { ok: true, value: snapshot as unknown as SituationCard };
  } catch {
    return INVALID;
  }
}
