/**
 * Everything a `ProduceInput` must satisfy before a prompt is built from it.
 * The events, the subject ids and the objects of earlier claims all come from
 * outside, so each element is checked here rather than at the point where a
 * missing field would raise a TypeError.
 */
import { SUBJECT_ROLES, isPlainObject } from "@kizuki/core";
import type { ProduceInput, QuotedEvent, SubjectRef } from "@kizuki/core";
import { configError } from "./errors";

const MAX_EVENTS = 256;
const MAX_SUBJECTS = 256;
const MAX_KNOWN_CLAIMS = 256;
const MAX_PREDICATES = 512;
const MAX_SUBJECT_ID_CHARS = 200;
const MAX_SUBJECTS_PER_EVENT = 64;
const MAX_PREDICATE_CHARS = 100;
const MAX_OBJECT_CHARS = 400;
/** A spine-generated event id. It names a fence, so it may not reshape one. */
const EVENT_ID = /^[A-Za-z0-9:._-]{1,200}$/;

function requireWholeNumber(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    configError(`producer input ${name} must be a whole number`);
  }
}

/**
 * A subject named by a record. The role is checked against the closed set the
 * contract declares rather than as any short string, so the value that comes
 * out of here is the type it claims to be without a cast.
 */
function isSubjectRef(value: unknown): value is SubjectRef {
  return (
    isPlainObject(value) &&
    shortString(value["subject_id"], MAX_SUBJECT_ID_CHARS) &&
    typeof value["role"] === "string" &&
    (SUBJECT_ROLES as readonly string[]).includes(value["role"])
  );
}

function isQuotedEvent(value: unknown): value is QuotedEvent {
  return (
    isPlainObject(value) &&
    typeof value["event_id"] === "string" &&
    EVENT_ID.test(value["event_id"]) &&
    typeof value["connector_id"] === "string" &&
    typeof value["occurred_at"] === "string" &&
    typeof value["observed_at"] === "string" &&
    typeof value["text"] === "string" &&
    Array.isArray(value["subjects"]) &&
    value["subjects"].length <= MAX_SUBJECTS_PER_EVENT &&
    value["subjects"].every(isSubjectRef) &&
    (value["taint"] === "untrusted" || value["taint"] === "owner")
  );
}

function shortString(
  value: unknown,
  max: number,
  nullable = false,
): boolean {
  if (value === null) return nullable;
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * The context is as attacker-shaped as the events: its ids come from source
 * records and its objects from an earlier model answer. Every element is
 * checked here so a bad one is a `PortError` rather than a `TypeError` raised
 * while the prompt is being built, or a `null` quietly sent to the endpoint.
 */
function validateContext(context: ProduceInput["context"]): void {
  for (const subject of context.subjects) {
    if (!isSubjectRef(subject)) {
      configError("producer input context carries an invalid subject");
    }
  }
  for (const claim of context.known_claims) {
    if (
      !isPlainObject(claim) ||
      !shortString(claim["claim_id"], MAX_SUBJECT_ID_CHARS) ||
      !shortString(claim["subject"], MAX_SUBJECT_ID_CHARS, true) ||
      !shortString(claim["predicate"], MAX_PREDICATE_CHARS, true) ||
      !shortString(claim["object"], MAX_OBJECT_CHARS, true) ||
      (claim["polarity"] !== "positive" && claim["polarity"] !== "negative") ||
      typeof claim["confidence"] !== "number" ||
      !Number.isFinite(claim["confidence"])
    ) {
      configError("producer input context carries an invalid known claim");
    }
  }
}

export function validateInput(input: ProduceInput): void {
  if (!isPlainObject(input)) configError("producer input must be an object");
  if (!Array.isArray(input.events) || input.events.length > MAX_EVENTS) {
    configError(`producer input must carry at most ${MAX_EVENTS} events`);
  }
  for (const event of input.events) {
    if (!isQuotedEvent(event)) {
      configError("producer input carries an invalid quoted event");
    }
  }

  const context = input.context;
  if (
    !isPlainObject(context) ||
    !Array.isArray(context.subjects) ||
    context.subjects.length > MAX_SUBJECTS ||
    !Array.isArray(context.known_claims) ||
    context.known_claims.length > MAX_KNOWN_CLAIMS ||
    !Array.isArray(context.predicates) ||
    context.predicates.length === 0 ||
    context.predicates.length > MAX_PREDICATES ||
    !context.predicates.every((predicate) =>
      shortString(predicate, MAX_PREDICATE_CHARS),
    )
  ) {
    configError("producer input context is invalid");
  }
  validateContext(context);

  const budget = input.budget;
  if (!isPlainObject(budget)) configError("producer input budget is invalid");
  requireWholeNumber(budget.max_calls, "budget.max_calls");
  requireWholeNumber(budget.max_input_tokens, "budget.max_input_tokens");
  requireWholeNumber(budget.max_output_tokens, "budget.max_output_tokens");
}
