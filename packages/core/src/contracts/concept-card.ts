import { compareRfc3339 } from "../agents/time";
import { isVisibleIdentifier } from "../util/opaque-identifier";
import { isRfc3339 } from "../util/time";
import { cloneExactJson, isPlainObject, utf8ByteLength } from "../util/validate";
import type { ExactJsonLimits } from "../util/validate";
import { isAuthorityTier } from "./proposal";
import type { AuthorityTier } from "./proposal";

export const CONCEPT_CARD_SCHEMA = "kizuki.concept-card/v1" as const;
export const KNOWLEDGE_NODE_SCHEMA = "kizuki.knowledge-node/v1" as const;
export const RELATION_SCHEMA = "kizuki.relation/v1" as const;

export type WorldWireKind =
  | "object"
  | "claim"
  | "admission"
  | "event_version"
  | "snapshot";
export type WorldWireRef<K extends WorldWireKind = WorldWireKind> = {
  readonly kind: K;
  readonly token: string;
};

type KnownTime =
  | { readonly kind: "known"; readonly from: string; readonly until: string | null }
  | { readonly kind: "unknown" };

export type ConceptEvidenceSpan =
  | { readonly kind: "text"; readonly startUtf16: number; readonly endUtf16: number }
  | { readonly kind: "metadata"; readonly field: string };

export type ConceptEvidenceRef = {
  readonly admission: WorldWireRef<"admission">;
  readonly eventVersion: WorldWireRef<"event_version">;
  readonly span: ConceptEvidenceSpan;
};

export type ConceptPerspective = {
  readonly holder: WorldWireRef<"object"> | null;
  readonly speaker: WorldWireRef<"object"> | null;
  readonly addressee: WorldWireRef<"object"> | null;
  readonly mode:
    | "asserted"
    | "quoted"
    | "reported"
    | "hypothetical"
    | "suggested"
    | "questioned"
    | "uncertain";
  readonly interpretation: "explicit" | "inferred";
  readonly evidence: readonly ConceptEvidenceRef[];
};

export type ConceptConfidence =
  | { readonly kind: "known"; readonly value: number }
  | { readonly kind: "unknown" };

export type ConceptEpistemicKind =
  | "observed"
  | "reported"
  | "owner_assertion"
  | "model_inference"
  | "hypothesis"
  | "recommendation"
  | "scenario";

export type ConceptAdmissionAssessment = {
  readonly admission: WorldWireRef<"admission">;
  readonly epistemicKind: ConceptEpistemicKind;
  readonly authority: AuthorityTier;
  readonly confidence: ConceptConfidence;
  readonly independence: "independent" | "dependent" | "unknown";
  readonly evidence: readonly ConceptEvidenceRef[];
};

export type ConceptRelationObject =
  | { readonly kind: "node"; readonly ref: WorldWireRef<"object"> }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "vocabulary"; readonly id: string };

export type Relation = {
  readonly schema: typeof RELATION_SCHEMA;
  readonly claim: WorldWireRef<"claim">;
  readonly subject: WorldWireRef<"object">;
  readonly predicate: string;
  readonly object: ConceptRelationObject;
  readonly perspective: ConceptPerspective;
  readonly context: readonly WorldWireRef<"object">[];
  readonly polarity: "positive" | "negative";
  readonly valid: KnownTime;
  readonly temporalBasis: "explicit" | "observed" | "unknown";
  readonly assessments: readonly ConceptAdmissionAssessment[];
  readonly conflict: "none_observed" | "present" | "unknown";
};

export type KnowledgeNode = {
  readonly schema: typeof KNOWLEDGE_NODE_SCHEMA;
  readonly ref: WorldWireRef<"object">;
  readonly kind: "concept";
  readonly classificationClaims: readonly WorldWireRef<"claim">[];
  readonly labels: readonly {
    readonly text: string;
    readonly claim: WorldWireRef<"claim">;
  }[];
  readonly resolution: "distinct" | "resolved" | "ambiguous";
};

export type ValidQuery =
  | { readonly kind: "all" }
  | { readonly kind: "at"; readonly at: string }
  | { readonly kind: "overlap"; readonly from: string; readonly until: string }
  | { readonly kind: "unknown_only" };

export type ViewGap =
  | "coverage"
  | "pending_consolidation"
  | "stale_dependencies"
  | "required_context_overflow"
  | "traversal_limit";

export type ConceptCoverage = {
  readonly status: "complete_for_query" | "partial";
  readonly gaps: readonly ViewGap[];
  readonly validWindow: ValidQuery;
  readonly history: "retained_for_query" | "baseline_only" | "unavailable";
};

export type ConceptLearningFacet =
  | "exposure"
  | "explanation"
  | "application"
  | "demonstration";

export type ConceptLearning = {
  readonly facet: ConceptLearningFacet;
  readonly assertion: Relation;
  readonly assistance: "assisted" | "unassisted" | "unknown";
  readonly assistanceEvidence: readonly Relation[];
};

export type ConceptCard = {
  readonly schema: typeof CONCEPT_CARD_SCHEMA;
  readonly concept: KnowledgeNode;
  readonly summary: {
    readonly text: string;
    readonly admissions: readonly WorldWireRef<"admission">[];
  } | null;
  readonly definitions: readonly Relation[];
  readonly relations: readonly Relation[];
  readonly learning: readonly ConceptLearning[];
  readonly knownAt:
    | { readonly kind: "current" }
    | { readonly kind: "snapshot"; readonly ref: WorldWireRef<"snapshot"> };
  readonly coverage: ConceptCoverage;
};

export type ConceptCardValidationResult =
  | { readonly ok: true; readonly value: ConceptCard }
  | { readonly ok: false; readonly errors: readonly ["invalid concept-card/v1 payload"] };

const WIRE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MODES = new Set<ConceptPerspective["mode"]>([
  "asserted",
  "quoted",
  "reported",
  "hypothetical",
  "suggested",
  "questioned",
  "uncertain",
]);
const EPISTEMIC = new Set<ConceptEpistemicKind>([
  "observed",
  "reported",
  "owner_assertion",
  "model_inference",
  "hypothesis",
  "recommendation",
  "scenario",
]);
const GAPS = new Set<ViewGap>([
  "coverage",
  "pending_consolidation",
  "stale_dependencies",
  "required_context_overflow",
  "traversal_limit",
]);
const FACETS = new Set<ConceptLearningFacet>([
  "exposure",
  "explanation",
  "application",
  "demonstration",
]);
const SNAPSHOT_LIMITS: ExactJsonLimits = {
  maxDepth: 12,
  maxKeysPerObject: 16,
  maxArrayLength: 256,
  maxStringBytes: 1200,
  maxKeyBytes: 64,
  maxTotalBytes: 262144,
};
const INVALID: ConceptCardValidationResult = Object.freeze({
  ok: false,
  errors: Object.freeze(["invalid concept-card/v1 payload"] as const),
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

function wireRef<K extends WorldWireKind>(value: unknown, kind: K): value is WorldWireRef<K> {
  return (
    isPlainObject(value) &&
    exact(value, ["kind", "token"]) &&
    value.kind === kind &&
    wireToken(value.token)
  );
}

function optionalObjectRef(value: unknown): value is WorldWireRef<"object"> | null {
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

function span(value: unknown): value is ConceptEvidenceSpan {
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

function evidenceRef(value: unknown): value is ConceptEvidenceRef {
  return (
    isPlainObject(value) &&
    exact(value, ["admission", "eventVersion", "span"]) &&
    wireRef(value.admission, "admission") &&
    wireRef(value.eventVersion, "event_version") &&
    span(value.span)
  );
}

function evidenceList(value: unknown): value is readonly ConceptEvidenceRef[] {
  return Array.isArray(value) && value.length <= 256 && value.every(evidenceRef);
}

function objectRefList(value: unknown): value is readonly WorldWireRef<"object">[] {
  return Array.isArray(value) && value.length <= 256 && value.every((item) => wireRef(item, "object"));
}

function claimRefList(value: unknown): value is readonly WorldWireRef<"claim">[] {
  return Array.isArray(value) && value.length <= 256 && value.every((item) => wireRef(item, "claim"));
}

function admissionRefList(value: unknown): value is readonly WorldWireRef<"admission">[] {
  return (
    Array.isArray(value) && value.length <= 256 && value.every((item) => wireRef(item, "admission"))
  );
}

function confidence(value: unknown): value is ConceptConfidence {
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

function assessment(value: unknown): value is ConceptAdmissionAssessment {
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
    EPISTEMIC.has(value.epistemicKind as ConceptEpistemicKind) &&
    isAuthorityTier(value.authority) &&
    confidence(value.confidence) &&
    (value.independence === "independent" ||
      value.independence === "dependent" ||
      value.independence === "unknown") &&
    evidenceList(value.evidence)
  );
}

function relationObject(value: unknown): value is ConceptRelationObject {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "node") {
    return exact(value, ["kind", "ref"]) && wireRef(value.ref, "object");
  }
  if (value.kind === "literal") {
    return exact(value, ["kind", "value"]) && boundedText(value.value, 400);
  }
  return value.kind === "vocabulary" && exact(value, ["kind", "id"]) && predicate(value.id);
}

function perspective(value: unknown): value is ConceptPerspective {
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
    MODES.has(value.mode as ConceptPerspective["mode"]) &&
    (value.interpretation === "explicit" || value.interpretation === "inferred") &&
    evidenceList(value.evidence)
  );
}

function relation(value: unknown): value is Relation {
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
    value.schema !== RELATION_SCHEMA ||
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

function relationList(value: unknown): value is readonly Relation[] {
  return Array.isArray(value) && value.length <= 256 && value.every(relation);
}

function knowledgeNode(value: unknown): value is KnowledgeNode {
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
    value.schema !== KNOWLEDGE_NODE_SCHEMA ||
    !wireRef(value.ref, "object") ||
    value.kind !== "concept" ||
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

function validQuery(value: unknown): value is ValidQuery {
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

function coverage(value: unknown): value is ConceptCoverage {
  return (
    isPlainObject(value) &&
    exact(value, ["status", "gaps", "validWindow", "history"]) &&
    (value.status === "complete_for_query" || value.status === "partial") &&
    Array.isArray(value.gaps) &&
    value.gaps.length <= 16 &&
    value.gaps.every((item) => typeof item === "string" && GAPS.has(item as ViewGap)) &&
    validQuery(value.validWindow) &&
    (value.history === "retained_for_query" ||
      value.history === "baseline_only" ||
      value.history === "unavailable")
  );
}

function summary(
  value: unknown,
): value is ConceptCard["summary"] {
  if (value === null) return true;
  return (
    isPlainObject(value) &&
    exact(value, ["text", "admissions"]) &&
    boundedText(value.text, 1200) &&
    admissionRefList(value.admissions)
  );
}

function knownAt(value: unknown): value is ConceptCard["knownAt"] {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "current") return exact(value, ["kind"]);
  return (
    value.kind === "snapshot" &&
    exact(value, ["kind", "ref"]) &&
    wireRef(value.ref, "snapshot")
  );
}

function learning(value: unknown): value is ConceptLearning {
  return (
    isPlainObject(value) &&
    exact(value, ["facet", "assertion", "assistance", "assistanceEvidence"]) &&
    FACETS.has(value.facet as ConceptLearningFacet) &&
    relation(value.assertion) &&
    (value.assistance === "assisted" ||
      value.assistance === "unassisted" ||
      value.assistance === "unknown") &&
    relationList(value.assistanceEvidence)
  );
}

/** Snapshots untrusted JSON before validating a closed concept card. */
export function validateConceptCard(input: unknown): ConceptCardValidationResult {
  try {
    const errors: string[] = [];
    const snapshot = cloneExactJson(input, "concept-card", SNAPSHOT_LIMITS, errors);
    if (
      snapshot === undefined ||
      !isPlainObject(snapshot) ||
      snapshot.schema !== CONCEPT_CARD_SCHEMA ||
      !exact(snapshot, [
        "schema",
        "concept",
        "summary",
        "definitions",
        "relations",
        "learning",
        "knownAt",
        "coverage",
      ]) ||
      !knowledgeNode(snapshot.concept) ||
      !summary(snapshot.summary) ||
      !relationList(snapshot.definitions) ||
      !relationList(snapshot.relations) ||
      !Array.isArray(snapshot.learning) ||
      snapshot.learning.length > 256 ||
      !snapshot.learning.every(learning) ||
      !knownAt(snapshot.knownAt) ||
      !coverage(snapshot.coverage)
    ) {
      return INVALID;
    }
    return { ok: true, value: snapshot as unknown as ConceptCard };
  } catch {
    return INVALID;
  }
}
