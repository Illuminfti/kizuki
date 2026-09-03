import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";
import type { ClaimDraft, ClaimDraftKind } from "../contracts/producer";
import type { Sensitivity } from "../agents/types";

/**
 * Strict `ExtractResponse` validation (RFC 0002 §4.2, §12.1). The provider
 * response is attacker-controlled input: exact key sets, closed enums, size
 * caps, no coercion. Any deviation is `schema_invalid` for the whole call.
 */

export const MAX_RESPONSE_CHARS = 400_000;
export const MAX_CLAIMS_PER_RESPONSE = 64;
export const MAX_OBJECT_CHARS = 400;
export const MAX_BODY_CHARS = 1_200;
export const MAX_SUBJECT_CHARS = 256;
export const MAX_PREDICATE_CHARS = 128;
export const MAX_EVENT_ID_CHARS = 64;
export const MAX_EVENT_IDS_PER_CLAIM = 32;

const RESPONSE_KEYS = ["claims"] as const;
const CLAIM_KEYS = [
  "kind",
  "subject",
  "predicate",
  "object",
  "polarity",
  "body",
  "valid_from",
  "valid_to",
  "confidence",
  "sensitivity",
  "event_ids",
] as const;
const CLAIM_KEY_SET: ReadonlySet<string> = new Set(CLAIM_KEYS);

const KINDS: ReadonlySet<string> = new Set<ClaimDraftKind>([
  "entity",
  "claim",
  "edit",
  "merge",
  "deletion",
]);
const POLARITIES: ReadonlySet<string> = new Set(["positive", "negative"]);
const SENSITIVITIES: ReadonlySet<string> = new Set<Sensitivity>([
  "public",
  "personal",
  "private",
]);

const UNSAFE_TEXT =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

export type ParseExtractResult =
  | { ok: true; claims: ClaimDraft[] }
  | { ok: false; detail: string };

function fail(detail: string): ParseExtractResult {
  return { ok: false, detail };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  return expected.every((key) => Object.hasOwn(value, key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function boundedSafeText(
  value: unknown,
  max: number,
  allowNewlines: boolean,
): value is string {
  return (
    boundedString(value, max) &&
    !UNSAFE_TEXT.test(value) &&
    (allowNewlines || !value.includes("\n"))
  );
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isRfc3339(value));
}

function readEventIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_EVENT_IDS_PER_CLAIM
  ) {
    return null;
  }
  const ids: string[] = [];
  for (const item of value) {
    if (!boundedString(item, MAX_EVENT_ID_CHARS)) return null;
    ids.push(item);
  }
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

function readClaim(raw: unknown, index: number): ClaimDraft | string {
  if (!isPlainObject(raw)) return `claims[${index}] is not an object`;
  if (!exactKeys(raw, CLAIM_KEYS)) {
    const unexpected = Object.keys(raw).filter((key) => !CLAIM_KEY_SET.has(key));
    return unexpected.length > 0
      ? `claims[${index}] has unexpected keys`
      : `claims[${index}] is missing keys`;
  }
  const kind = raw["kind"];
  const subject = raw["subject"];
  const predicate = raw["predicate"];
  const object = raw["object"];
  const polarity = raw["polarity"];
  const body = raw["body"];
  const validFrom = raw["valid_from"];
  const validTo = raw["valid_to"];
  const confidence = raw["confidence"];
  const sensitivity = raw["sensitivity"];
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    return `claims[${index}].kind is not a claim kind`;
  }
  if (!boundedSafeText(subject, MAX_SUBJECT_CHARS, false)) {
    return `claims[${index}].subject is not a bounded string`;
  }
  if (!boundedSafeText(predicate, MAX_PREDICATE_CHARS, false)) {
    return `claims[${index}].predicate is not a bounded string`;
  }
  if (!boundedSafeText(object, MAX_OBJECT_CHARS, false)) {
    return `claims[${index}].object is not a bounded string`;
  }
  if (typeof polarity !== "string" || !POLARITIES.has(polarity)) {
    return `claims[${index}].polarity is not a polarity`;
  }
  if (!boundedSafeText(body, MAX_BODY_CHARS, true)) {
    return `claims[${index}].body is not a bounded string`;
  }
  if (!nullableTimestamp(validFrom)) {
    return `claims[${index}].valid_from is not RFC3339 or null`;
  }
  if (!nullableTimestamp(validTo)) {
    return `claims[${index}].valid_to is not RFC3339 or null`;
  }
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return `claims[${index}].confidence is not in 0..1`;
  }
  if (typeof sensitivity !== "string" || !SENSITIVITIES.has(sensitivity)) {
    return `claims[${index}].sensitivity is not a sensitivity`;
  }
  const eventIds = readEventIds(raw["event_ids"]);
  if (eventIds === null) {
    return `claims[${index}].event_ids is not a bounded non-empty unique list`;
  }
  return {
    kind: kind as ClaimDraftKind,
    subject,
    predicate,
    object,
    polarity: polarity as "positive" | "negative",
    body,
    valid_from: validFrom,
    valid_to: validTo,
    confidence,
    sensitivity: sensitivity as Sensitivity,
    event_ids: eventIds,
  };
}

/**
 * Parses raw response text into validated drafts. Never throws on model
 * output; a failure names the field, never the offending value.
 */
export function parseExtractResponse(text: string): ParseExtractResult {
  if (typeof text !== "string") return fail("response is not text");
  if (text.length > MAX_RESPONSE_CHARS) return fail("response exceeds the size cap");

  const source = text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return fail("response is not JSON");
  }
  if (!isPlainObject(parsed)) return fail("response is not an object");
  if (!exactKeys(parsed, RESPONSE_KEYS)) {
    return fail("response keys are not exactly {claims}");
  }
  const rawClaims = parsed["claims"];
  if (!Array.isArray(rawClaims)) return fail("claims is not a list");
  if (rawClaims.length > MAX_CLAIMS_PER_RESPONSE) {
    return fail("claims exceeds the per-response cap");
  }

  const claims: ClaimDraft[] = [];
  for (const [index, raw] of rawClaims.entries()) {
    const claim = readClaim(raw, index);
    if (typeof claim === "string") return fail(claim);
    claims.push(claim);
  }
  return { ok: true, claims };
}

/** A verbatim run this long from any quoted record makes a body a capture, not prose. */
export const VERBATIM_RUN_CHARS = 100;
const VERBATIM_WINDOW = 80;
const VERBATIM_STEP = VERBATIM_RUN_CHARS - VERBATIM_WINDOW;

/**
 * True when `body` contains at least `VERBATIM_RUN_CHARS` consecutive
 * characters of any source text. Any such run contains a full aligned window
 * of `VERBATIM_WINDOW` characters, so the scan is bounded by
 * `sum(len(source)) / VERBATIM_STEP` substring checks.
 */
export function containsVerbatimCapture(
  body: string,
  sources: readonly string[],
): boolean {
  if (body.length < VERBATIM_WINDOW) return false;
  for (const source of sources) {
    if (source.length < VERBATIM_WINDOW) continue;
    for (
      let start = 0;
      start + VERBATIM_WINDOW <= source.length;
      start += VERBATIM_STEP
    ) {
      if (body.includes(source.slice(start, start + VERBATIM_WINDOW))) {
        return true;
      }
    }
  }
  return false;
}
