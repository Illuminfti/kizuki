import { isPlainObject, isRfc3339 } from "@kizuki/core";
import type { ClaimDraft, ClaimDraftKind, Sensitivity } from "@kizuki/core";
import { reject } from "./errors";
import { sanitize } from "./text";

const CLAIM_KEYS = new Set([
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
]);
const KINDS = new Set<string>(["entity", "claim", "edit", "merge", "deletion"]);
const SENSITIVITIES = new Set<string>(["public", "personal", "private"]);

export const MAX_CLAIMS = 64;
const MAX_SUBJECT_CHARS = 200;
const MAX_PREDICATE_CHARS = 100;
const MAX_OBJECT_CHARS = 400;
const MAX_BODY_CHARS = 1200;
const MAX_EVENT_IDS = 32;
const MAX_UNKNOWN_PREDICATES = 16;

/**
 * Keys, quoting, the two timestamps, the numbers and a few citations: what a
 * draft costs beyond the fields this reader bounds by length.
 */
const CLAIM_ENVELOPE_CHARS = 512;

/**
 * The characters one accepted draft can cost as JSON, every bounded field at
 * its ceiling. A caller sizes what it lets a call generate from this, so an
 * answer this reader would accept is never cut off at the token limit and
 * refused as malformed instead.
 */
export const MAX_CLAIM_CHARS =
  MAX_SUBJECT_CHARS +
  MAX_PREDICATE_CHARS +
  MAX_OBJECT_CHARS +
  MAX_BODY_CHARS +
  CLAIM_ENVELOPE_CHARS;

/**
 * A candidate for the registry is an identifier in the shape of RFC 0002
 * §5.6, never prose. Anything else the model put in `predicate` is dropped
 * without being retained: only a name that could become a registry entry is
 * worth carrying back, and provider free text must not travel on a result.
 */
const PREDICATE_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;


export interface ExtractOutcome {
  claims: ClaimDraft[];
  /**
   * Identifier-shaped predicates the model named that the registry does not
   * hold, so the registry can grow deliberately.
   */
  unknown_predicates: string[];
}

function text(
  claim: Record<string, unknown>,
  key: string,
  max: number,
  allowNewlines: boolean,
): string {
  const raw = claim[key];
  if (typeof raw !== "string" || raw.length > max) {
    reject("schema_invalid", `a claim has an invalid ${key}`);
  }
  const value = sanitize(raw, allowNewlines);
  if (value.length === 0) {
    reject("schema_invalid", `a claim has an empty ${key}`);
  }
  return value;
}

function timestamp(claim: Record<string, unknown>, key: string): string | null {
  const raw = claim[key];
  if (raw === null) return null;
  if (typeof raw !== "string" || !isRfc3339(raw)) {
    reject("schema_invalid", `a claim has an invalid ${key}`);
  }
  return raw;
}

function citations(
  claim: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string[] {
  const raw = claim["event_ids"];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_EVENT_IDS ||
    !raw.every((id) => typeof id === "string")
  ) {
    reject("schema_invalid", "a claim has an invalid event_ids list");
  }
  const ids = [...new Set(raw as string[])];
  if (!ids.every((id) => allowed.has(id))) {
    reject(
      "provenance_not_cited",
      "a claim cited an event that was not in the request",
    );
  }
  return ids;
}

/**
 * Validates the model's answer against `ExtractResponse` exactly. An extra
 * key is a rejection, not a warning; an unknown predicate drops that one
 * draft so the registry stays a deliberate list rather than a drifting enum.
 */
export function parseExtractResponse(
  answer: string,
  allowedEventIds: ReadonlySet<string>,
  allowedPredicates: ReadonlySet<string>,
): ExtractOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    reject(
      "schema_invalid",
      "the endpoint answered with text that is not JSON",
    );
  }
  if (!isPlainObject(parsed)) {
    reject(
      "schema_invalid",
      "the endpoint answered with a value that is not an object",
    );
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "claims") {
      reject("schema_invalid", `the answer carries an unexpected key ${key}`);
    }
  }
  const rawClaims = parsed["claims"];
  if (!Array.isArray(rawClaims) || rawClaims.length > MAX_CLAIMS) {
    reject("schema_invalid", "the answer carries an invalid claims list");
  }

  const claims: ClaimDraft[] = [];
  const unknown = new Set<string>();
  for (const entry of rawClaims) {
    if (!isPlainObject(entry)) {
      reject(
        "schema_invalid",
        "the answer carries a claim that is not an object",
      );
    }
    for (const key of Object.keys(entry)) {
      if (!CLAIM_KEYS.has(key)) {
        reject("schema_invalid", `a claim carries an unexpected key ${key}`);
      }
    }
    for (const key of CLAIM_KEYS) {
      if (!(key in entry))
        reject("schema_invalid", `a claim is missing ${key}`);
    }

    const kind = entry["kind"];
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      reject("schema_invalid", "a claim has an invalid kind");
    }
    const polarity = entry["polarity"];
    if (polarity !== "positive" && polarity !== "negative") {
      reject("schema_invalid", "a claim has an invalid polarity");
    }
    const sensitivity = entry["sensitivity"];
    if (typeof sensitivity !== "string" || !SENSITIVITIES.has(sensitivity)) {
      reject("schema_invalid", "a claim has an invalid sensitivity");
    }
    const confidence = entry["confidence"];
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      reject("schema_invalid", "a claim has an invalid confidence");
    }

    // The whole draft is validated before the registry decides its fate, so
    // a broken claim is `schema_invalid` whatever it named: an answer that
    // fails its shape must never reach a caller as `ok` with no claims.
    const draft: ClaimDraft = {
      kind: kind as ClaimDraftKind,
      subject: text(entry, "subject", MAX_SUBJECT_CHARS, false),
      predicate: text(entry, "predicate", MAX_PREDICATE_CHARS, false),
      object: text(entry, "object", MAX_OBJECT_CHARS, false),
      polarity,
      body: text(entry, "body", MAX_BODY_CHARS, true),
      valid_from: timestamp(entry, "valid_from"),
      valid_to: timestamp(entry, "valid_to"),
      confidence,
      sensitivity: sensitivity as Sensitivity,
      event_ids: citations(entry, allowedEventIds),
    };
    if (!allowedPredicates.has(draft.predicate)) {
      if (
        PREDICATE_ID.test(draft.predicate) &&
        unknown.size < MAX_UNKNOWN_PREDICATES
      ) {
        unknown.add(draft.predicate);
      }
      continue;
    }
    claims.push(draft);
  }

  return { claims, unknown_predicates: [...unknown].sort() };
}
