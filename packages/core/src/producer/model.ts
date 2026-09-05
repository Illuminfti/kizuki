import type { SubjectRef } from "../contracts/event";
import type { LlmMessage, LlmPort, LlmResponse } from "../contracts/llm";
import {
  PRODUCER_CONTRACT,
  PRODUCER_CONTRACT_MINOR,
} from "../contracts/producer";
import type {
  ClaimDraft,
  ClaimSummary,
  DroppedDraft,
  ModelUsage,
  ProduceInput,
  ProduceResult,
  ProducerDiagnostic,
  ProducerPort,
  QuotedEvent,
  RejectReason,
} from "../contracts/producer";
import { PortError, isPortErrorCode, validatePortDescriptor } from "../contracts/ports";
import type {
  PortContext,
  PortDescriptor,
  PortHealth,
} from "../contracts/ports";
import { registerPort } from "../contracts/registry";
import type { PortRegistry } from "../contracts/registry";
import { isRfc3339 } from "../util/time";
import { isNonEmptyString, isPlainObject } from "../util/validate";
import { escapeFenceText, hasFenceLeak, newFenceNonce } from "./fence";
import { buildExtractionMessages } from "./prompt";
import {
  MAX_EVENT_ID_CHARS,
  containsVerbatimCapture,
  parseExtractResponse,
} from "./schema";

export const MODEL_PRODUCER_ID = "kizuki.producer.model" as const;

export const MODEL_PRODUCER_DESCRIPTOR: PortDescriptor = validatePortDescriptor({
  id: MODEL_PRODUCER_ID,
  kind: "producer",
  contract: PRODUCER_CONTRACT,
  contract_minor: PRODUCER_CONTRACT_MINOR,
  supports: ["model"],
  requires_lease: false,
  optional_package: null,
});

/** One call per batch of at most this many events (RFC 0002 §4.2). */
export const EXTRACT_BATCH = 8;
/** At most this many characters of quoted text per call (RFC 0002 §4.2). */
export const EXTRACT_INPUT_CHARS = 24_000;
/** Output ceiling per call, below the transport's own bound. */
export const EXTRACT_MAX_OUTPUT_TOKENS = 8_192;
/** Conservative chars-per-token for charging input before the request. */
export const CHARS_PER_TOKEN = 4;

export const DEFAULT_PRODUCER_DEADLINE_MS = 60_000;
const MIN_DEADLINE_MS = 1_000;
const MAX_DEADLINE_MS = 600_000;
const MAX_EVENTS_PER_INPUT = 4_096;
const MAX_SUBJECTS = 4_096;
const MAX_KNOWN_CLAIMS = 4_096;
const MAX_PREDICATES = 1_024;
const MAX_BUDGET = 1_000_000_000;

const EVENT_ID = /^[A-Za-z0-9:_.-]{1,64}$/;
const CONNECTOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PREDICATE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

export interface ModelProducerOptions {
  /** The bound `kizuki.llm/v1` port. The producer does not own or close it. */
  readonly llm: LlmPort;
}

export interface ModelProducerConfig {
  readonly deadline_ms: number;
}

export interface ModelProducerPort extends ProducerPort {
  /** `<port_id>:<model>@<host>` of the bound model, for claim stamps. */
  readonly model_ref: string | null;
}

function configError(message: string): never {
  throw new PortError("config_invalid", message, false);
}

export function parseModelProducerConfig(value: unknown): ModelProducerConfig {
  if (!isPlainObject(value)) configError("producer config must be a table");
  for (const key of Object.keys(value)) {
    if (key !== "deadline_ms") configError(`unknown producer config key ${key}`);
  }
  const deadline = value["deadline_ms"];
  if (deadline === undefined) {
    return { deadline_ms: DEFAULT_PRODUCER_DEADLINE_MS };
  }
  if (
    typeof deadline !== "number" ||
    !Number.isSafeInteger(deadline) ||
    deadline < MIN_DEADLINE_MS ||
    deadline > MAX_DEADLINE_MS
  ) {
    configError("deadline_ms is out of range");
  }
  return { deadline_ms: deadline };
}

function inputError(message: string): never {
  throw new PortError("config_invalid", `produce input: ${message}`, false);
}

function isBudgetValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_BUDGET
  );
}

function validateSubject(subject: unknown, path: string): SubjectRef {
  if (!isPlainObject(subject)) inputError(`${path} is not an object`);
  if (!isNonEmptyString(subject["subject_id"]) || subject["subject_id"].length > 256) {
    inputError(`${path}.subject_id is not a bounded string`);
  }
  const role = subject["role"];
  if (role !== "about" && role !== "from" && role !== "to") {
    inputError(`${path}.role is not a subject role`);
  }
  const display = subject["display_name"];
  if (display !== undefined && (typeof display !== "string" || display.length > 1_024)) {
    inputError(`${path}.display_name is not a bounded string`);
  }
  return {
    subject_id: subject["subject_id"],
    role,
    ...(typeof display === "string" ? { display_name: display } : {}),
  };
}

function validateEvent(event: unknown, index: number): QuotedEvent {
  const path = `events[${index}]`;
  if (!isPlainObject(event)) inputError(`${path} is not an object`);
  const eventId = event["event_id"];
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) {
    inputError(`${path}.event_id is not a bounded id`);
  }
  const connectorId = event["connector_id"];
  if (typeof connectorId !== "string" || !CONNECTOR_ID.test(connectorId)) {
    inputError(`${path}.connector_id is not a connector id`);
  }
  const occurredAt = event["occurred_at"];
  const observedAt = event["observed_at"];
  if (typeof occurredAt !== "string" || !isRfc3339(occurredAt)) {
    inputError(`${path}.occurred_at is not RFC3339`);
  }
  if (typeof observedAt !== "string" || !isRfc3339(observedAt)) {
    inputError(`${path}.observed_at is not RFC3339`);
  }
  const text = event["text"];
  if (typeof text !== "string") inputError(`${path}.text is not a string`);
  const taint = event["taint"];
  if (taint !== "untrusted" && taint !== "owner") {
    inputError(`${path}.taint is not untrusted or owner`);
  }
  const subjects = event["subjects"];
  if (!Array.isArray(subjects) || subjects.length > MAX_SUBJECTS) {
    inputError(`${path}.subjects is not a bounded list`);
  }
  return {
    event_id: eventId,
    connector_id: connectorId,
    occurred_at: occurredAt,
    observed_at: observedAt,
    text,
    subjects: subjects.map((subject, subjectIndex) =>
      validateSubject(subject, `${path}.subjects[${subjectIndex}]`),
    ),
    taint,
  };
}

function validateKnownClaim(claim: unknown, index: number): ClaimSummary {
  const path = `context.known_claims[${index}]`;
  if (!isPlainObject(claim)) inputError(`${path} is not an object`);
  if (!isNonEmptyString(claim["claim_id"]) || claim["claim_id"].length > 64) {
    inputError(`${path}.claim_id is not a bounded string`);
  }
  for (const key of ["subject", "predicate", "object"] as const) {
    const value = claim[key];
    if (value !== null && (typeof value !== "string" || value.length > 1_024)) {
      inputError(`${path}.${key} is not a bounded string or null`);
    }
  }
  const polarity = claim["polarity"];
  if (polarity !== "positive" && polarity !== "negative") {
    inputError(`${path}.polarity is not a polarity`);
  }
  const confidence = claim["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    inputError(`${path}.confidence is not in 0..1`);
  }
  return {
    claim_id: claim["claim_id"],
    subject: claim["subject"] as string | null,
    predicate: claim["predicate"] as string | null,
    object: claim["object"] as string | null,
    polarity,
    confidence,
  };
}

export function validateProduceInput(input: unknown): ProduceInput {
  if (!isPlainObject(input)) inputError("not an object");
  const events = input["events"];
  if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_INPUT) {
    inputError("events is not a bounded list");
  }
  const validatedEvents = events.map(validateEvent);
  if (new Set(validatedEvents.map((event) => event.event_id)).size !== validatedEvents.length) {
    inputError("events contains a duplicate event_id");
  }

  const context = input["context"];
  if (!isPlainObject(context)) inputError("context is not an object");
  const subjects = context["subjects"];
  const knownClaims = context["known_claims"];
  const predicates = context["predicates"];
  if (!Array.isArray(subjects) || subjects.length > MAX_SUBJECTS) {
    inputError("context.subjects is not a bounded list");
  }
  if (!Array.isArray(knownClaims) || knownClaims.length > MAX_KNOWN_CLAIMS) {
    inputError("context.known_claims is not a bounded list");
  }
  if (!Array.isArray(predicates) || predicates.length > MAX_PREDICATES) {
    inputError("context.predicates is not a bounded list");
  }
  for (const predicate of predicates) {
    if (typeof predicate !== "string" || !PREDICATE.test(predicate) || predicate.length > 128) {
      inputError("context.predicates contains a malformed predicate");
    }
  }
  if (new Set(predicates).size !== predicates.length) {
    inputError("context.predicates contains a duplicate");
  }

  const budget = input["budget"];
  if (!isPlainObject(budget)) inputError("budget is not an object");
  if (
    !isBudgetValue(budget["max_calls"]) ||
    !isBudgetValue(budget["max_input_tokens"]) ||
    !isBudgetValue(budget["max_output_tokens"])
  ) {
    inputError("budget values must be non-negative safe integers");
  }

  return {
    events: validatedEvents,
    context: {
      subjects: subjects.map((subject, index) =>
        validateSubject(subject, `context.subjects[${index}]`),
      ),
      known_claims: knownClaims.map(validateKnownClaim),
      predicates: predicates as string[],
    },
    budget: {
      max_calls: budget["max_calls"],
      max_input_tokens: budget["max_input_tokens"],
      max_output_tokens: budget["max_output_tokens"],
    },
  };
}

interface Batch {
  readonly events: QuotedEvent[];
  readonly chars: number;
}

/**
 * Splits events into calls of at most `EXTRACT_BATCH` events and
 * `EXTRACT_INPUT_CHARS` characters of quoted text. An event that cannot fit
 * in a call by itself is never truncated; it is dropped and reported.
 */
export function planBatches(
  events: readonly QuotedEvent[],
): { batches: Batch[]; dropped: DroppedDraft[] } {
  const batches: Batch[] = [];
  const dropped: DroppedDraft[] = [];
  let current: QuotedEvent[] = [];
  let chars = 0;
  const flush = (): void => {
    if (current.length > 0) batches.push({ events: current, chars });
    current = [];
    chars = 0;
  };
  for (const event of events) {
    const length = escapeFenceText(event.text).length;
    if (length > EXTRACT_INPUT_CHARS) {
      dropped.push({
        reason: "event_too_large",
        event_id: event.event_id,
        chars: length,
      });
      continue;
    }
    if (current.length >= EXTRACT_BATCH || chars + length > EXTRACT_INPUT_CHARS) {
      flush();
    }
    current.push(event);
    chars += length;
  }
  flush();
  return { batches, dropped };
}

function estimateTokens(messages: readonly { content: string }[]): number {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

interface PlannedModelCall {
  readonly events: readonly QuotedEvent[];
  readonly nonce: string;
  readonly messages: readonly LlmMessage[];
  readonly max_output_tokens: number;
}

type BudgetDiagnostic = Extract<ProducerDiagnostic, { stage: "budget" }>;
export type ModelExtractionPlan =
  | { readonly status: "ready"; readonly input: ProduceInput; readonly calls: readonly PlannedModelCall[] }
  | { readonly status: "rejected"; readonly diagnostic: BudgetDiagnostic };

/** Prepare and reserve the complete request set before any external call. */
export function planModelExtraction(rawInput: ProduceInput): ModelExtractionPlan {
  const input = validateProduceInput(rawInput);
  const reject = (rule: BudgetDiagnostic["rule"], requested: number, limit: number): ModelExtractionPlan =>
    ({ status: "rejected", diagnostic: { stage: "budget", rule, used: 0, requested, limit } });
  const { batches, dropped } = planBatches(input.events);
  const oversized = dropped.find(item => item.reason === "event_too_large");
  if (oversized?.reason === "event_too_large") return reject("max_quoted_chars", oversized.chars, EXTRACT_INPUT_CHARS);
  if (batches.length > input.budget.max_calls) return reject("max_calls", batches.length, input.budget.max_calls);
  const calls: PlannedModelCall[] = [];
  let inputReserved = 0;
  let outputReserved = 0;
  for (const batch of batches) {
    const subjects = new Map<string, SubjectRef>();
    for (const event of batch.events) for (const subject of event.subjects) subjects.set(subject.subject_id, subject);
    const nonce = newFenceNonce();
    const messages = buildExtractionMessages({ events: batch.events, subjects: [...subjects.values()],
      known_claims: input.context.known_claims.filter(claim => claim.subject !== null && subjects.has(claim.subject)),
      predicates: input.context.predicates }, nonce);
    inputReserved += estimateTokens(messages);
    if (inputReserved > input.budget.max_input_tokens) return reject("max_input_tokens", inputReserved, input.budget.max_input_tokens);
    const maxOutput = Math.min(EXTRACT_MAX_OUTPUT_TOKENS, input.budget.max_output_tokens - outputReserved);
    if (maxOutput < 1) return reject("max_output_tokens", outputReserved + 1, input.budget.max_output_tokens);
    outputReserved += maxOutput;
    calls.push({ events: batch.events, nonce, messages, max_output_tokens: maxOutput });
  }
  return { status: "ready", input, calls };
}

type CallOutcome =
  | { kind: "ok"; response: LlmResponse }
  | { kind: "rejected"; reason: RejectReason; diagnostic: ProducerDiagnostic }
  | { kind: "unavailable"; reason: string; diagnostic: ProducerDiagnostic };

function classifyLlmError(error: unknown): Exclude<CallOutcome, { kind: "ok" }> {
  if (!(error instanceof PortError)) return { kind: "unavailable", reason: "llm error", diagnostic: { stage: "transport", rule: "unavailable" } };
  if (error.code === "not_supported" && error.message === "rejected: tool_call_in_response") {
    return { kind: "rejected", reason: "tool_call_in_response", diagnostic: { stage: "response", rule: "tool_call" } };
  }
  for (const rule of ["bad_response", "unsupported_metadata", "response_refused", "response_truncated", "response_incomplete", "response_too_large"] as const) {
    if (error.code === "unavailable" && error.message === `rejected: ${rule}`) return { kind: "rejected", reason: "schema_invalid", diagnostic: { stage: "response", rule } };
  }
  let diagnostic: ProducerDiagnostic = { stage: "transport", rule: "unavailable" };
  if (error.code === "timeout") diagnostic = { stage: "transport", rule: "timeout" };
  else if (error.message === "model network") diagnostic = { stage: "transport", rule: "network" };
  else if (error.message === "model redirect") diagnostic = { stage: "transport", rule: "redirect" };
  else if (error.message === "secret reference did not resolve") diagnostic = { stage: "transport", rule: "credentials" };
  else if (/^http [1-5][0-9]{2}$/.test(error.message)) diagnostic = { stage: "transport", rule: "http", http_status: Number(error.message.slice(5)) };
  return { kind: "unavailable", reason: `llm ${isPortErrorCode(error.code) ? error.code : "unavailable"}`, diagnostic };
}

async function callModel(
  llm: LlmPort,
  messages: ReturnType<typeof buildExtractionMessages>,
  maxOutputTokens: number,
  deadlineMs: number,
): Promise<CallOutcome> {
  try {
    const response = await llm.complete({
      messages,
      max_output_tokens: maxOutputTokens,
      deadline_ms: deadlineMs,
    });
    return { kind: "ok", response };
  } catch (error) {
    return classifyLlmError(error);
  }
}

export function createModelProducerPort(
  ctx: PortContext,
  options: ModelProducerOptions,
): ModelProducerPort {
  const config = parseModelProducerConfig(ctx.config);
  const llm = options?.llm;
  if (llm === undefined || typeof llm.complete !== "function") {
    configError("model producer requires a bound llm port");
  }
  let closed = false;

  const assertOpen = (): void => {
    if (closed) {
      throw new PortError("unavailable", "producer port is closed", false);
    }
  };

  const drop = (item: DroppedDraft): void => {
    ctx.logger({
      level: "warn",
      message: "draft_dropped",
      detail: { reason: item.reason },
    });
  };

  return {
    descriptor: MODEL_PRODUCER_DESCRIPTOR,
    get model_ref(): string | null {
      return llm.model_ref;
    },
    async health(): Promise<PortHealth> {
      if (closed) {
        return { status: "unavailable", reason: "producer port is closed" };
      }
      const upstream = await llm.health();
      if (upstream.status === "unavailable") {
        return { status: "unavailable", reason: `llm: ${upstream.reason}` };
      }
      const detail = {
        model_ref: llm.model_ref,
        extract_batch: EXTRACT_BATCH,
        extract_input_chars: EXTRACT_INPUT_CHARS,
      };
      if (upstream.status === "degraded") {
        return { status: "degraded", degraded: upstream.degraded, detail };
      }
      return { status: "ready", detail };
    },
    async produce(rawInput: ProduceInput): Promise<ProduceResult> {
      assertOpen();
      const usage: { -readonly [K in keyof ModelUsage]: ModelUsage[K] } = {
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
      };
      const claims: ClaimDraft[] = [];
      const dropped: DroppedDraft[] = [];
      const plan = planModelExtraction(rawInput);
      if (plan.status === "rejected") return { status: "rejected", reason: "budget_exhausted", usage, diagnostic: plan.diagnostic };
      const predicates = new Set(plan.input.context.predicates);

      for (const batch of plan.calls) {
        assertOpen();
        const batchSubjects = new Set(batch.events.flatMap(event => event.subjects.map(subject => subject.subject_id)));
        const outcome = await callModel(llm, batch.messages, batch.max_output_tokens, config.deadline_ms);
        usage.calls += 1;
        if (outcome.kind === "unavailable") {
          // A transport failure is not an empty call.  Preserve the charged
          // attempt in the receipt so an unavailable model cannot masquerade
          // as a rail that never contacted its configured port.
          return { status: "unavailable", reason: outcome.reason, usage, diagnostic: outcome.diagnostic };
        }
        if (outcome.kind === "rejected") {
          return { status: "rejected", reason: outcome.reason, usage, diagnostic: outcome.diagnostic };
        }
        usage.input_tokens += outcome.response.usage.input_tokens;
        usage.output_tokens += outcome.response.usage.output_tokens;

        const text = outcome.response.text;
        if (hasFenceLeak(text, batch.nonce)) {
          return { status: "rejected", reason: "fence_leak", usage };
        }
        const parsed = parseExtractResponse(text);
        if (!parsed.ok) {
          ctx.logger({
            level: "warn",
            message: "extract_schema_invalid",
            detail: { detail: parsed.detail },
          });
          return { status: "rejected", reason: "schema_invalid", usage, diagnostic: parsed.diagnostic };
        }

        const batchEventIds = new Set(batch.events.map((event) => event.event_id));
        const subjectsByEvent = new Map(
          batch.events.map((event) => [
            event.event_id,
            new Set(event.subjects.map((subject) => subject.subject_id)),
          ]),
        );
        const sources = batch.events.map((event) => event.text);

        for (const [index, draft] of parsed.claims.entries()) {
          if (!draft.event_ids.every((id) => batchEventIds.has(id))) {
            return { status: "rejected", reason: "provenance_not_cited", usage };
          }
          if (containsVerbatimCapture(draft.body, sources)) {
            ctx.logger({
              level: "warn",
              message: "extract_schema_invalid",
              detail: { detail: "body reproduces quoted text verbatim" },
            });
            return { status: "rejected", reason: "schema_invalid", usage,
              diagnostic: { stage: "claims", rule: "verbatim", field: "body", shape: "string", claim_index: index, claim_count: parsed.claims.length } };
          }
        }
        for (const draft of parsed.claims) {
          if (!predicates.has(draft.predicate)) {
            const item: DroppedDraft = {
              reason: "unknown_predicate",
              predicate: draft.predicate,
              event_ids: [...draft.event_ids],
            };
            dropped.push(item);
            drop(item);
            continue;
          }
          if (!batchSubjects.has(draft.subject)) {
            const item: DroppedDraft = {
              reason: "unknown_subject",
              subject: draft.subject,
              event_ids: [...draft.event_ids],
            };
            dropped.push(item);
            drop(item);
            continue;
          }
          if (!draft.event_ids.every((id) => subjectsByEvent.get(id)?.has(draft.subject) === true)) {
            return { status: "rejected", reason: "provenance_not_cited", usage };
          }
          claims.push(draft);
        }
      }

      return { status: "ok", claims, usage, dropped };
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

/**
 * Registers `kizuki.producer.model`. The factory needs the bound llm port,
 * which the composition root supplies per context; the producer holds no
 * other handle.
 */
export function registerModelProducerPort(
  llmFor: (ctx: PortContext) => LlmPort,
  registry?: PortRegistry,
): void {
  const factory = (ctx: PortContext): ModelProducerPort =>
    createModelProducerPort(ctx, { llm: llmFor(ctx) });
  if (registry === undefined) {
    registerPort(MODEL_PRODUCER_DESCRIPTOR, factory);
  } else {
    registry.registerPort(MODEL_PRODUCER_DESCRIPTOR, factory);
  }
}
