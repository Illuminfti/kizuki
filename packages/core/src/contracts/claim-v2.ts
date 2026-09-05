import { isVisibleIdentifier } from "../util/opaque-identifier";
import { EVENT_LIMITS } from "./event";
import { isRfc3339 } from "../util/time";
import { isUlid } from "../util/ulid";
import { cloneExactJson, isPlainObject, utf8ByteLength } from "../util/validate";
import type { ExactJsonLimits } from "../util/validate";
import type { TextAnchor } from "./producer-v2";

export const CLAIM_V2_SCHEMA = "kizuki.claim/v2" as const;

export type RawSubjectRef = {
  readonly kind: "occurrence" | "supplied";
  readonly id: string;
};

export type ClaimV2Object = {
  readonly kind: "literal";
  readonly value: string;
} | {
  readonly kind: "subject";
  readonly ref: RawSubjectRef;
} | {
  readonly kind: "vocabulary";
  readonly ref: {
    readonly kind: "vocabulary";
    readonly id: string;
  };
};

export interface ClaimV2Perspective {
  readonly holder: RawSubjectRef | null;
  readonly speaker: RawSubjectRef | null;
  readonly addressee: RawSubjectRef | null;
  readonly mode: "asserted" | "quoted" | "reported" | "hypothetical" | "suggested" | "questioned" | "uncertain";
  readonly interpretation: "explicit" | "inferred";
  readonly anchors: readonly TextAnchor[];
}

export interface ClaimV2Assertion {
  readonly schema: typeof CLAIM_V2_SCHEMA;
  readonly discriminator: "assertion";
  readonly subject: RawSubjectRef;
  readonly predicate: string;
  readonly object: ClaimV2Object;
  readonly perspective: ClaimV2Perspective;
  readonly context: readonly RawSubjectRef[];
  readonly polarity: "positive" | "negative";
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly temporal_basis: "explicit" | "observed" | "unknown";
  readonly anchors: readonly TextAnchor[];
}

export type IdentityChange = {
  readonly action: "merge";
  readonly left: RawSubjectRef;
  readonly right: RawSubjectRef;
} | {
  readonly action: "separate";
  readonly partitions: readonly (readonly RawSubjectRef[])[];
} | {
  readonly action: "undo";
  readonly receipt_id: string;
};

export interface ClaimV2IdentityControl {
  readonly schema: typeof CLAIM_V2_SCHEMA;
  readonly discriminator: "identity_control";
  readonly change: IdentityChange;
  readonly expected_component_digest: string;
  readonly policy_version: string;
}

export type ClaimV2Semantic = ClaimV2Assertion | ClaimV2IdentityControl;

export type ClaimV2ValidationResult = {
  readonly ok: true;
  readonly value: ClaimV2Semantic;
} | {
  readonly ok: false;
  readonly errors: readonly [
    "invalid claim/v2 payload"
  ];
};
const REF_MAX_BYTES = EVENT_LIMITS.subjectIdBytes;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MODES = new Set<ClaimV2Perspective["mode"]>([
  "asserted", "quoted", "reported", "hypothetical", "suggested", "questioned", "uncertain"
]);
const SNAPSHOT_LIMITS: ExactJsonLimits = {
  maxDepth: 8, maxKeysPerObject: 16, maxArrayLength: 256, maxStringBytes: 1200, maxKeyBytes: 64, maxTotalBytes: 512 * 1024
};
const INVALID: ClaimV2ValidationResult = Object.freeze({ ok: false, errors: Object.freeze(["invalid claim/v2 payload"] as const) });

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function rawRef(value: unknown): value is RawSubjectRef {
  return isPlainObject(value) &&
    exact(value, ["kind", "id"]) &&
    (value.kind === "occurrence" ||
    value.kind === "supplied") &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= REF_MAX_BYTES &&
    utf8ByteLength(value.id) <= REF_MAX_BYTES &&
    isVisibleIdentifier(value.id);
}

function refKey(value: RawSubjectRef): string {
  return `${value.kind}\u0000${value.id}`;
}

function anchor(value: unknown): value is TextAnchor {
  if (!isPlainObject(value) || !exact(value, ["event_id", "start_utf16", "end_utf16"])) {
    return false;
  }
  const start = value.start_utf16, end = value.end_utf16;
  return isUlid(value.event_id) &&
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start;
}

function anchors(value: unknown, min: number): value is readonly TextAnchor[] {
  return Array.isArray(value) &&
    value.length >= min &&
    value.length <= 8 &&
    value.every(anchor) &&
    new Set(value.map(item => `${item.event_id}:${item.start_utf16}:${item.end_utf16}`)).size === value.length;
}

function sorted(refs: readonly RawSubjectRef[]): boolean {
  return refs.every((ref, index) => index === 0 || refKey(refs[index - 1]!) < refKey(ref));
}
/** Snapshots untrusted JSON before validating a closed normalized payload. */
export function validateClaimV2Semantic(input: unknown): ClaimV2ValidationResult {
  try {
    const errors: string[] = [];
    const snapshot = cloneExactJson(input, "claim_v2", SNAPSHOT_LIMITS, errors);
    if (snapshot === undefined || !isPlainObject(snapshot) || snapshot.schema !== CLAIM_V2_SCHEMA) {
      return INVALID;
    }
    if (snapshot.discriminator === "assertion") {
      return validateAssertion(snapshot);
    }
    if (snapshot.discriminator === "identity_control") {
      return validateIdentityControl(snapshot);
    }
  }
  catch {
    return INVALID;
  }
  return INVALID;
}

function validateAssertion(value: Record<string, unknown>): ClaimV2ValidationResult {
  const keys = [
    "schema", "discriminator", "subject", "predicate", "object", "perspective", "context", "polarity", "valid_from", "valid_to", "temporal_basis", "anchors"
  ];
  if (!exact(value, keys) ||
    !rawRef(value.subject) ||
    typeof value.predicate !== "string" ||
    !TOKEN.test(value.predicate) ||
    !isObject(value.object) ||
    !isPerspective(value.perspective) ||
    !Array.isArray(value.context) ||
    !value.context.every(rawRef) ||
    !anchors(value.anchors, 1)) {
    return INVALID;
  }
  if (value.polarity !== "positive" && value.polarity !== "negative") {
    return INVALID;
  }
  if (value.temporal_basis !== "explicit" && value.temporal_basis !== "observed" && value.temporal_basis !== "unknown") {
    return INVALID;
  }
  if ((value.valid_from !== null && !isRfc3339(value.valid_from)) || (value.valid_to !== null && !isRfc3339(value.valid_to))) {
    return INVALID;
  }
  if (value.temporal_basis !== "unknown" && value.valid_from === null) {
    return INVALID;
  }
  if (value.temporal_basis === "unknown" && (value.valid_from !== null || value.valid_to !== null)) {
    return INVALID;
  }
  if (value.valid_from !== null && value.valid_to !== null && Date.parse(value.valid_to) <= Date.parse(value.valid_from)) {
    return INVALID;
  }
  const context = value.context as RawSubjectRef[];
  if (context.length > 8 || !sorted(context)) {
    return INVALID;
  }
  return { ok: true, value: value as unknown as ClaimV2Assertion };
}

function isObject(value: unknown): value is ClaimV2Object {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "literal") {
    return exact(value, ["kind", "value"]) && typeof value.value === "string" && value.value.length > 0 && value.value.length <= 400;
  }
  if (value.kind === "subject") {
    return exact(value, ["kind", "ref"]) && rawRef(value.ref);
  }
  return value.kind === "vocabulary" &&
    exact(value, ["kind", "ref"]) &&
    isPlainObject(value.ref) &&
    exact(value.ref, ["kind", "id"]) &&
    value.ref.kind === "vocabulary" &&
    typeof value.ref.id === "string" &&
    value.ref.id.length > 0 &&
    utf8ByteLength(value.ref.id) <= REF_MAX_BYTES &&
    isVisibleIdentifier(value.ref.id);
}

function isPerspective(value: unknown): value is ClaimV2Perspective {
  if (!isPlainObject(value) || !exact(value, [
    "holder", "speaker", "addressee", "mode", "interpretation", "anchors"
  ]) ||
    !MODES.has(value.mode as ClaimV2Perspective["mode"]) ||
    (value.interpretation !== "explicit" &&
    value.interpretation !== "inferred") ||
    !anchors(value.anchors, 0)) {
    return false;
  }
  const roles = [value.holder, value.speaker, value.addressee];
  return roles.every(role => role === null || rawRef(role)) && (roles.every(role => role === null) || value.anchors.length > 0);
}

function validateIdentityControl(value: Record<string, unknown>): ClaimV2ValidationResult {
  return exact(value, [
    "schema", "discriminator", "change", "expected_component_digest", "policy_version"
  ]) &&
    typeof value.expected_component_digest === "string" &&
    SHA256.test(value.expected_component_digest) &&
    typeof value.policy_version === "string" &&
    TOKEN.test(value.policy_version) &&
    isIdentityChange(value.change) ? { ok: true, value: value as unknown as ClaimV2IdentityControl } : INVALID;
}

function isIdentityChange(value: unknown): value is IdentityChange {
  if (!isPlainObject(value) || typeof value.action !== "string") {
    return false;
  }
  if (value.action === "merge") {
    return exact(value, ["action", "left", "right"]) &&
      rawRef(value.left) &&
      rawRef(value.right) &&
      refKey(value.left) < refKey(value.right);
  }
  if (value.action === "undo") {
    return exact(value, ["action", "receipt_id"]) && typeof value.receipt_id === "string" && TOKEN.test(value.receipt_id);
  }
  if (value.action !== "separate" ||
    !exact(value, ["action", "partitions"]) ||
    !Array.isArray(value.partitions) ||
    value.partitions.length < 2 ||
    value.partitions.length > 16) {
    return false;
  }
  let total = 0;
  let previous = "";
  const seen = new Set<string>();
  for (const partition of value.partitions) {
    if (!Array.isArray(partition) || partition.length === 0 || !partition.every(rawRef) || !sorted(partition)) {
      return false;
    }
    total += partition.length;
    const key = partition.map(refKey).join("\u0001");
    if (total > 256 || (previous !== "" && previous >= key)) {
      return false;
    }
    for (const ref of partition) {
      if (seen.has(refKey(ref))) {
        return false;
      }
      seen.add(refKey(ref));
    }
    previous = key;
  }
  return true;
}
