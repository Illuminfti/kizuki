/**
 * The parts every world card codec shares: the wire reference, the qualified
 * relation, the knowledge node, coverage, and the strict validators for them,
 * plus `cardCodec`, which turns a schema id and the validator of each field
 * into a closed card validator. A new kind's card file declares its own shape
 * and imports the rest from here; `concept-card` and `situation-card` are the
 * two shipped examples.
 *
 * Not exported from the contracts index: card files re-export the names they
 * have always published, so the public surface does not change.
 */
import { compareRfc3339 } from "../agents/time";
import { isVisibleIdentifier } from "../util/opaque-identifier";
import { isRfc3339 } from "../util/time";
import {
  cloneExactJson,
  isPlainObject,
  utf8ByteLength,
} from "../util/validate";
import type { ExactJsonLimits } from "../util/validate";
import { isAuthorityTier } from "./proposal";
import type { AuthorityTier } from "./proposal";

export const KNOWLEDGE_NODE_SCHEMA = "kizuki.knowledge-node/v1" as const;
export const RELATION_SCHEMA = "kizuki.relation/v1" as const;

export type WorldWireKind =
  "object" | "claim" | "admission" | "event_version" | "snapshot";
export type WorldWireRef<K extends WorldWireKind = WorldWireKind> = {
  readonly kind: K;
  readonly token: string;
};

export type KnownTime =
  | {
      readonly kind: "known";
      readonly from: string;
      readonly until: string | null;
    }
  | { readonly kind: "unknown" };

export type EvidenceSpan =
  | {
      readonly kind: "text";
      readonly startUtf16: number;
      readonly endUtf16: number;
    }
  | { readonly kind: "metadata"; readonly field: string };

export type EvidenceRef = {
  readonly admission: WorldWireRef<"admission">;
  readonly eventVersion: WorldWireRef<"event_version">;
  readonly span: EvidenceSpan;
};

export type Perspective = {
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
  readonly evidence: readonly EvidenceRef[];
};

export type Confidence =
  | { readonly kind: "known"; readonly value: number }
  | { readonly kind: "unknown" };

export type EpistemicKind =
  | "observed"
  | "reported"
  | "owner_assertion"
  | "model_inference"
  | "hypothesis"
  | "recommendation"
  | "scenario";

export type AdmissionAssessment = {
  readonly admission: WorldWireRef<"admission">;
  readonly epistemicKind: EpistemicKind;
  readonly authority: AuthorityTier;
  readonly confidence: Confidence;
  readonly independence: "independent" | "dependent" | "unknown";
  readonly evidence: readonly EvidenceRef[];
};

export type RelationObject =
  | { readonly kind: "node"; readonly ref: WorldWireRef<"object"> }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "vocabulary"; readonly id: string };

export type Relation = {
  readonly schema: typeof RELATION_SCHEMA;
  readonly claim: WorldWireRef<"claim">;
  readonly subject: WorldWireRef<"object">;
  readonly predicate: string;
  readonly object: RelationObject;
  readonly perspective: Perspective;
  readonly context: readonly WorldWireRef<"object">[];
  readonly polarity: "positive" | "negative";
  readonly valid: KnownTime;
  readonly temporalBasis: "explicit" | "observed" | "unknown";
  readonly assessments: readonly AdmissionAssessment[];
  readonly conflict: "none_observed" | "present" | "unknown";
};

export type KnowledgeNode<Kind extends string = string> = {
  readonly schema: typeof KNOWLEDGE_NODE_SCHEMA;
  readonly ref: WorldWireRef<"object">;
  readonly kind: Kind;
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

export type Coverage = {
  readonly status: "complete_for_query" | "partial";
  readonly gaps: readonly ViewGap[];
  readonly validWindow: ValidQuery;
  readonly history: "retained_for_query" | "baseline_only" | "unavailable";
};

export type CardSummary = {
  readonly text: string;
  readonly admissions: readonly WorldWireRef<"admission">[];
};

export type CardKnownAt =
  | { readonly kind: "current" }
  | { readonly kind: "snapshot"; readonly ref: WorldWireRef<"snapshot"> };

const WIRE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MODES = new Set<Perspective["mode"]>([
  "asserted",
  "quoted",
  "reported",
  "hypothetical",
  "suggested",
  "questioned",
  "uncertain",
]);
const EPISTEMIC = new Set<EpistemicKind>([
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
const SNAPSHOT_LIMITS: ExactJsonLimits = {
  maxDepth: 12,
  maxKeysPerObject: 16,
  maxArrayLength: 256,
  maxStringBytes: 1200,
  maxKeyBytes: 64,
  maxTotalBytes: 262144,
};

export function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function wireToken(value: unknown): value is string {
  if (typeof value !== "string" || !WIRE_TOKEN.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").byteLength === 32;
  } catch {
    return false;
  }
}

export function wireRef<K extends WorldWireKind>(
  value: unknown,
  kind: K,
): value is WorldWireRef<K> {
  return (
    isPlainObject(value) &&
    exact(value, ["kind", "token"]) &&
    value.kind === kind &&
    wireToken(value.token)
  );
}

function optionalObjectRef(
  value: unknown,
): value is WorldWireRef<"object"> | null {
  return value === null || wireRef(value, "object");
}

export function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8ByteLength(value) <= maxBytes &&
    isVisibleIdentifier(value)
  );
}

function predicate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    FIELD.test(value) &&
    utf8ByteLength(value) <= 128
  );
}

function knownTime(value: unknown): value is KnownTime {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "unknown") return exact(value, ["kind"]);
  if (value.kind !== "known" || !exact(value, ["kind", "from", "until"]))
    return false;
  if (
    !isRfc3339(value.from) ||
    (value.until !== null && !isRfc3339(value.until))
  ) {
    return false;
  }
  return (
    value.until === null ||
    compareRfc3339(value.until, "until", value.from, "from") > 0
  );
}

function span(value: unknown): value is EvidenceSpan {
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
  return (
    value.kind === "metadata" &&
    exact(value, ["kind", "field"]) &&
    predicate(value.field)
  );
}

export function evidenceRef(value: unknown): value is EvidenceRef {
  return (
    isPlainObject(value) &&
    exact(value, ["admission", "eventVersion", "span"]) &&
    wireRef(value.admission, "admission") &&
    wireRef(value.eventVersion, "event_version") &&
    span(value.span)
  );
}

function evidenceList(value: unknown): value is readonly EvidenceRef[] {
  return (
    Array.isArray(value) && value.length <= 256 && value.every(evidenceRef)
  );
}

export function objectRefList(
  value: unknown,
): value is readonly WorldWireRef<"object">[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every((item) => wireRef(item, "object"))
  );
}

function claimRefList(
  value: unknown,
): value is readonly WorldWireRef<"claim">[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every((item) => wireRef(item, "claim"))
  );
}

function admissionRefList(
  value: unknown,
): value is readonly WorldWireRef<"admission">[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every((item) => wireRef(item, "admission"))
  );
}

function confidence(value: unknown): value is Confidence {
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

function assessment(value: unknown): value is AdmissionAssessment {
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
    EPISTEMIC.has(value.epistemicKind as EpistemicKind) &&
    isAuthorityTier(value.authority) &&
    confidence(value.confidence) &&
    (value.independence === "independent" ||
      value.independence === "dependent" ||
      value.independence === "unknown") &&
    evidenceList(value.evidence)
  );
}

function relationObject(value: unknown): value is RelationObject {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "node") {
    return exact(value, ["kind", "ref"]) && wireRef(value.ref, "object");
  }
  if (value.kind === "literal") {
    return exact(value, ["kind", "value"]) && boundedText(value.value, 400);
  }
  return (
    value.kind === "vocabulary" &&
    exact(value, ["kind", "id"]) &&
    predicate(value.id)
  );
}

function perspective(value: unknown): value is Perspective {
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
    MODES.has(value.mode as Perspective["mode"]) &&
    (value.interpretation === "explicit" ||
      value.interpretation === "inferred") &&
    evidenceList(value.evidence)
  );
}

export function relation(value: unknown): value is Relation {
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

export function optionalRelation(value: unknown): value is Relation | null {
  return value === null || relation(value);
}

export function relationList(value: unknown): value is readonly Relation[] {
  return Array.isArray(value) && value.length <= 256 && value.every(relation);
}

/** A node of `kind`: the closed key set, the kind literal, claim refs and bounded labels. */
export function knowledgeNode(
  value: unknown,
  kind: string,
): value is KnowledgeNode {
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
    value.kind !== kind ||
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

export function coverage(value: unknown): value is Coverage {
  return (
    isPlainObject(value) &&
    exact(value, ["status", "gaps", "validWindow", "history"]) &&
    (value.status === "complete_for_query" || value.status === "partial") &&
    Array.isArray(value.gaps) &&
    value.gaps.length <= 16 &&
    value.gaps.every(
      (item) => typeof item === "string" && GAPS.has(item as ViewGap),
    ) &&
    validQuery(value.validWindow) &&
    (value.history === "retained_for_query" ||
      value.history === "baseline_only" ||
      value.history === "unavailable")
  );
}

export function summary(value: unknown): value is CardSummary | null {
  if (value === null) return true;
  return (
    isPlainObject(value) &&
    exact(value, ["text", "admissions"]) &&
    boundedText(value.text, 1200) &&
    admissionRefList(value.admissions)
  );
}

export function knownAt(value: unknown): value is CardKnownAt {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "current") return exact(value, ["kind"]);
  return (
    value.kind === "snapshot" &&
    exact(value, ["kind", "ref"]) &&
    wireRef(value.ref, "snapshot")
  );
}

export type CardValidation<Card, Label extends string> =
  | { readonly ok: true; readonly value: Card }
  | {
      readonly ok: false;
      readonly errors: readonly [`invalid ${Label}/v1 payload`];
    };

/**
 * A closed card validator. It snapshots untrusted JSON within fixed bounds,
 * then accepts only an object whose `schema` is `schema` and whose keys are
 * exactly `schema` plus the keys of `fields`, each passing its own check. Any
 * failure, including a throw, is the same fixed refusal.
 */
export function cardCodec<Card, Label extends string>(spec: {
  readonly schema: string;
  readonly label: Label;
  readonly fields: Readonly<Record<string, (value: unknown) => boolean>>;
}): (input: unknown) => CardValidation<Card, Label> {
  const keys = ["schema", ...Object.keys(spec.fields)];
  const invalid: CardValidation<Card, Label> = Object.freeze({
    ok: false as const,
    errors: Object.freeze([`invalid ${spec.label}/v1 payload`] as const),
  });
  return (input) => {
    try {
      const snapshot = cloneExactJson(input, spec.label, SNAPSHOT_LIMITS, []);
      if (
        snapshot === undefined ||
        !isPlainObject(snapshot) ||
        snapshot.schema !== spec.schema ||
        !exact(snapshot, keys) ||
        !Object.entries(spec.fields).every(([key, check]) =>
          check(snapshot[key]),
        )
      ) {
        return invalid;
      }
      return { ok: true, value: snapshot as unknown as Card };
    } catch {
      return invalid;
    }
  };
}
