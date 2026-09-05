import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";
import type { ClaimDiagnostic, ClaimDraft, ClaimDraftKind } from "../contracts/producer";
import type { Sensitivity } from "../agents/types";
import { diagnosticShape } from "./diagnostics";

/**
 * Strict `ExtractResponse` validation (RFC 0002 §4.2, §12.1). The extracted
 * claim payload is attacker-controlled input: exact key sets, closed enums,
 * size caps, no coercion. Any deviation is `schema_invalid` for the whole
 * call. Provider envelope metadata is projected by the LLM port, not here.
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

/** One optional Markdown code fence around the object is formatting, not schema. */
const CODE_FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;

export type ParseExtractResult =
  | { ok: true; claims: ClaimDraft[] }
  | { ok: false; detail: string; diagnostic: ClaimDiagnostic };
type SchemaFailure = Extract<ParseExtractResult, { ok: false }>;

function fail(detail: string, field: ClaimDiagnostic["field"], rule: ClaimDiagnostic["rule"], value: unknown, index: number | null = null, count: number | null = null): SchemaFailure {
  return { ok: false, detail, diagnostic: { stage: "claims", field, rule, shape: diagnosticShape(value), claim_index: index, claim_count: count } };
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

function readClaim(raw: unknown, index: number, count: number): ClaimDraft | SchemaFailure {
  const invalid = (field: ClaimDiagnostic["field"], rule: ClaimDiagnostic["rule"], value: unknown, detail: string) => fail(detail, field, rule, value, index, count);
  if (!isPlainObject(raw)) return invalid("claim", "object", raw, `claims[${index}] is not an object`);
  if (!exactKeys(raw, CLAIM_KEYS)) {
    const unexpected = Object.keys(raw).filter((key) => !CLAIM_KEY_SET.has(key));
    if (unexpected.length > 0) return invalid("claim", "extra_field", raw, `claims[${index}] has unexpected keys`);
    const missing = CLAIM_KEYS.find(key => !Object.hasOwn(raw, key))!;
    return invalid(missing, "missing_field", undefined, `claims[${index}] is missing keys (${missing})`);
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
    return invalid("kind", "enum", kind, `claims[${index}].kind is not a claim kind`);
  }
  if (!boundedString(subject, MAX_SUBJECT_CHARS)) {
    return invalid("subject", "bounded_string", subject, `claims[${index}].subject is not a bounded string`);
  }
  if (!boundedString(predicate, MAX_PREDICATE_CHARS)) {
    return invalid("predicate", "bounded_string", predicate, `claims[${index}].predicate is not a bounded string`);
  }
  if (!boundedString(object, MAX_OBJECT_CHARS)) {
    return invalid("object", "bounded_string", object, `claims[${index}].object is not a bounded string`);
  }
  if (typeof polarity !== "string" || !POLARITIES.has(polarity)) {
    return invalid("polarity", "enum", polarity, `claims[${index}].polarity is not a polarity`);
  }
  if (!boundedString(body, MAX_BODY_CHARS)) {
    return invalid("body", "bounded_string", body, `claims[${index}].body is not a bounded string`);
  }
  if (!nullableTimestamp(validFrom)) {
    return invalid("valid_from", "timestamp", validFrom, `claims[${index}].valid_from is not RFC3339 or null`);
  }
  if (!nullableTimestamp(validTo)) {
    return invalid("valid_to", "timestamp", validTo, `claims[${index}].valid_to is not RFC3339 or null`);
  }
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return invalid("confidence", "confidence", confidence, `claims[${index}].confidence is not in 0..1`);
  }
  if (typeof sensitivity !== "string" || !SENSITIVITIES.has(sensitivity)) {
    return invalid("sensitivity", "enum", sensitivity, `claims[${index}].sensitivity is not a sensitivity`);
  }
  const eventIds = readEventIds(raw["event_ids"]);
  if (eventIds === null) {
    return invalid("event_ids", "event_ids", raw["event_ids"], `claims[${index}].event_ids is not a bounded non-empty unique list`);
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
  if (typeof text !== "string") return fail("response is not text", "response", "text", text);
  if (text.length > MAX_RESPONSE_CHARS) return fail("response exceeds the size cap", "response", "size_cap", text);

  let source = text.trim();
  const fenced = CODE_FENCE.exec(source);
  if (fenced !== null && fenced[1] !== undefined) source = fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return fail("response is not JSON", "response", "json", source);
  }
  if (!isPlainObject(parsed)) return fail("response is not an object", "response", "object", parsed);
  const rawClaims = parsed["claims"];
  const count = Array.isArray(rawClaims) ? rawClaims.length : null;
  if (!exactKeys(parsed, RESPONSE_KEYS)) {
    return fail("response keys are not exactly {claims}", "response", Object.hasOwn(parsed, "claims") ? "extra_field" : "missing_field", parsed, null, count);
  }
  if (!Array.isArray(rawClaims)) return fail("claims is not a list", "claims", "list", rawClaims);
  if (rawClaims.length > MAX_CLAIMS_PER_RESPONSE) {
    return fail("claims exceeds the per-response cap", "claims", "list_cap", rawClaims, null, count);
  }

  const claims: ClaimDraft[] = [];
  for (const [index, raw] of rawClaims.entries()) {
    const claim = readClaim(raw, index, rawClaims.length);
    if ("ok" in claim) return claim;
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
