import { isVisibleIdentifier } from "../util/opaque-identifier";
import { EVENT_LIMITS } from "./event";
import { isRfc3339 } from "../util/time";
import { compareRfc3339 } from "../agents/time";
import { isUlid } from "../util/ulid";
import { cloneExactJson, isPlainObject, utf8ByteLength } from "../util/validate";
import type { ExactJsonLimits } from "../util/validate";
import type { RawSubjectRef } from "./claim-v2";

export const OBSERVATION_RECORD_SCHEMA = "kizuki.observation-record/v1" as const;

export type InternalId<K extends string> = string & { readonly internalKind: K };

export type KnownTime =
  | { readonly kind: "known"; readonly from: string; readonly until: string | null }
  | { readonly kind: "unknown" };

export type Recorded = {
  readonly admittedAt: string;
  readonly admissionSeq: number;
};

export type DurableEvidenceSpan =
  | { readonly kind: "text"; readonly startUtf16: number; readonly endUtf16: number }
  | { readonly kind: "metadata"; readonly field: string };

export type DurableEvidenceSourceBinding = {
  readonly sourceKey: string;
  readonly grantRevision: number;
  readonly policyDigest: string;
};

export type DurableEvidence = {
  readonly id: InternalId<"evidence">;
  readonly admissionId: InternalId<"admission">;
  readonly eventId: InternalId<"event">;
  readonly eventHashVersion: 1 | 2;
  readonly eventHash: string;
  readonly textHash: string;
  readonly originBinding: string;
  readonly eventAcceptedAt: string;
  readonly sourceBinding: DurableEvidenceSourceBinding | null;
  readonly span: DurableEvidenceSpan;
};

export type DurableAttribution = {
  readonly id: InternalId<"attribution">;
  readonly role: "sender" | "recipient" | "quoted_author" | "thread" | "place";
  readonly ref: RawSubjectRef;
  readonly basis: "source_field";
  readonly field: string;
  readonly evidenceIds: readonly InternalId<"evidence">[];
};

export type DurableObservation = {
  readonly schema: typeof OBSERVATION_RECORD_SCHEMA;
  readonly id: InternalId<"observation">;
  readonly admissionId: InternalId<"admission">;
  readonly evidence: readonly DurableEvidence[];
  readonly attribution: readonly DurableAttribution[];
  readonly fidelity: "verbatim_text" | "source_metadata" | "lossy_transcript";
  readonly occurred: KnownTime;
  readonly sourceObservedAt: string | null;
  readonly recorded: Recorded;
};

export type DurableObservationValidationResult =
  | { readonly ok: true; readonly value: DurableObservation }
  | { readonly ok: false; readonly errors: readonly ["invalid observation-record/v1 payload"] };

const SHA256 = /^[0-9a-f]{64}$/;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ROLES = new Set<DurableAttribution["role"]>([
  "sender",
  "recipient",
  "quoted_author",
  "thread",
  "place",
]);
const FIDELITIES = new Set<DurableObservation["fidelity"]>([
  "verbatim_text",
  "source_metadata",
  "lossy_transcript",
]);
const SNAPSHOT_LIMITS: ExactJsonLimits = {
  maxDepth: 8,
  maxKeysPerObject: 16,
  maxArrayLength: 256,
  maxStringBytes: 1200,
  maxKeyBytes: 64,
  maxTotalBytes: 262144,
};
const INVALID: DurableObservationValidationResult = Object.freeze({
  ok: false,
  errors: Object.freeze(["invalid observation-record/v1 payload"] as const),
});
const REF_MAX_BYTES = EVENT_LIMITS.subjectIdBytes;

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function rawRef(value: unknown): value is RawSubjectRef {
  return (
    isPlainObject(value) &&
    exact(value, ["kind", "id"]) &&
    (value.kind === "occurrence" || value.kind === "supplied") &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= REF_MAX_BYTES &&
    utf8ByteLength(value.id) <= REF_MAX_BYTES &&
    isVisibleIdentifier(value.id)
  );
}

function originBinding(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8ByteLength(value) <= 128 &&
    isVisibleIdentifier(value)
  );
}

function fieldName(value: unknown): value is string {
  return typeof value === "string" && FIELD.test(value) && utf8ByteLength(value) <= 128;
}

function sourceKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8ByteLength(value) <= EVENT_LIMITS.identifierBytes &&
    isVisibleIdentifier(value)
  );
}

function knownTime(value: unknown): value is KnownTime {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "unknown") {
    return exact(value, ["kind"]);
  }
  if (value.kind !== "known" || !exact(value, ["kind", "from", "until"])) {
    return false;
  }
  if (!isRfc3339(value.from) || (value.until !== null && !isRfc3339(value.until))) {
    return false;
  }
  return value.until === null || compareRfc3339(value.until, "until", value.from, "from") > 0;
}

function sourceBinding(value: unknown): value is DurableEvidenceSourceBinding | null {
  if (value === null) return true;
  return (
    isPlainObject(value) &&
    exact(value, ["sourceKey", "grantRevision", "policyDigest"]) &&
    sourceKey(value.sourceKey) &&
    Number.isInteger(value.grantRevision) &&
    (value.grantRevision as number) >= 0 &&
    typeof value.policyDigest === "string" &&
    SHA256.test(value.policyDigest)
  );
}

function span(value: unknown): value is DurableEvidenceSpan {
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

function evidence(value: unknown, admissionId: string): value is DurableEvidence {
  if (
    !isPlainObject(value) ||
    !exact(value, [
      "id",
      "admissionId",
      "eventId",
      "eventHashVersion",
      "eventHash",
      "textHash",
      "originBinding",
      "eventAcceptedAt",
      "sourceBinding",
      "span",
    ])
  ) {
    return false;
  }
  return (
    isUlid(value.id) &&
    value.admissionId === admissionId &&
    isUlid(value.eventId) &&
    (value.eventHashVersion === 1 || value.eventHashVersion === 2) &&
    typeof value.eventHash === "string" &&
    SHA256.test(value.eventHash) &&
    typeof value.textHash === "string" &&
    SHA256.test(value.textHash) &&
    originBinding(value.originBinding) &&
    isRfc3339(value.eventAcceptedAt) &&
    sourceBinding(value.sourceBinding) &&
    span(value.span)
  );
}

function attribution(
  value: unknown,
  evidenceIds: ReadonlySet<string>,
): value is DurableAttribution {
  if (
    !isPlainObject(value) ||
    !exact(value, ["id", "role", "ref", "basis", "field", "evidenceIds"]) ||
    !isUlid(value.id) ||
    !ROLES.has(value.role as DurableAttribution["role"]) ||
    !rawRef(value.ref) ||
    value.basis !== "source_field" ||
    !fieldName(value.field) ||
    !Array.isArray(value.evidenceIds) ||
    value.evidenceIds.length === 0 ||
    value.evidenceIds.length > 256
  ) {
    return false;
  }
  const ids = value.evidenceIds as unknown[];
  if (!ids.every((id) => typeof id === "string" && evidenceIds.has(id))) {
    return false;
  }
  return new Set(ids as string[]).size === ids.length;
}

function recorded(value: unknown): value is Recorded {
  return (
    isPlainObject(value) &&
    exact(value, ["admittedAt", "admissionSeq"]) &&
    isRfc3339(value.admittedAt) &&
    Number.isInteger(value.admissionSeq) &&
    (value.admissionSeq as number) >= 0
  );
}

/** Snapshots untrusted JSON before validating a closed observation record. */
export function validateDurableObservation(
  input: unknown,
): DurableObservationValidationResult {
  try {
    const errors: string[] = [];
    const snapshot = cloneExactJson(input, "observation", SNAPSHOT_LIMITS, errors);
    if (
      snapshot === undefined ||
      !isPlainObject(snapshot) ||
      snapshot.schema !== OBSERVATION_RECORD_SCHEMA ||
      !exact(snapshot, [
        "schema",
        "id",
        "admissionId",
        "evidence",
        "attribution",
        "fidelity",
        "occurred",
        "sourceObservedAt",
        "recorded",
      ]) ||
      !isUlid(snapshot.id) ||
      !isUlid(snapshot.admissionId) ||
      !FIDELITIES.has(snapshot.fidelity as DurableObservation["fidelity"]) ||
      !knownTime(snapshot.occurred) ||
      (snapshot.sourceObservedAt !== null && !isRfc3339(snapshot.sourceObservedAt)) ||
      !recorded(snapshot.recorded) ||
      !Array.isArray(snapshot.evidence) ||
      snapshot.evidence.length === 0 ||
      snapshot.evidence.length > 256 ||
      !Array.isArray(snapshot.attribution) ||
      snapshot.attribution.length > 256
    ) {
      return INVALID;
    }
    const admissionId = snapshot.admissionId as string;
    if (!snapshot.evidence.every((item) => evidence(item, admissionId))) {
      return INVALID;
    }
    const evidenceIds = snapshot.evidence.map((item) => (item as DurableEvidence).id);
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      return INVALID;
    }
    const evidenceSet = new Set<string>(evidenceIds);
    if (!snapshot.attribution.every((item) => attribution(item, evidenceSet))) {
      return INVALID;
    }
    const attributionIds = snapshot.attribution.map((item) => (item as DurableAttribution).id);
    if (new Set(attributionIds).size !== attributionIds.length) {
      return INVALID;
    }
    return { ok: true, value: snapshot as unknown as DurableObservation };
  } catch {
    return INVALID;
  }
}
