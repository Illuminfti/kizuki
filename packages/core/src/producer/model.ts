import type { SubjectRef } from "../contracts/event";
import type { LlmPort, LlmResponse } from "../contracts/llm";
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
  ProducerPort,
  QuotedEvent,
  RejectReason,
} from "../contracts/producer";
import { PortError, validatePortDescriptor } from "../contracts/ports";
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
import { containsVerbatimCapture, parseExtractResponse } from "./schema";

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
/** A single record may occupy at most eight full extraction calls. */
export const MAX_EVENT_TEXT_CHARS = EXTRACT_INPUT_CHARS * 8;
/** Output ceiling per call, below the transport's own bound. */
export const EXTRACT_MAX_OUTPUT_TOKENS = 8_192;
/** Approximate English characters per token for pre-request input charging. */
export const CHARS_PER_TOKEN = 4;

export const DEFAULT_PRODUCER_DEADLINE_MS = 60_000;
const MIN_DEADLINE_MS = 1_000;
const MAX_DEADLINE_MS = 600_000;
const MAX_EVENTS_PER_INPUT = 4_096;
const MAX_SUBJECTS = 4_096;
const MAX_KNOWN_CLAIMS = 4_096;
const MAX_PREDICATES = 1_024;
const MAX_BUDGET = 1_000_000_000;
const MAX_LLM_RESPONSE_CHARS = 8_388_608;
const MAX_MODEL_NAME_CHARS = 200;
const MESSAGE_FRAMING_TOKENS = 8;
const PREFLIGHT_FENCE_NONCE = "00000000000000000000000000000000";

const EVENT_ID = /^[A-Za-z0-9:_.-]{1,64}$/;
const CONNECTOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PREDICATE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

const TOOL_CALL_MARK = "tool_call_in_response";
const PERMANENT_LLM_ERRORS: ReadonlySet<string> = new Set([
  "config_invalid",
  "contract_mismatch",
  "lease_required",
  "not_supported",
  "space_mismatch",
]);

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
  if (text.length > MAX_EVENT_TEXT_CHARS) {
    inputError(`${path}.text exceeds the producer resource bound`);
  }
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

function fittedEventChunk(
  text: string,
  offset: number,
): { text: string; end: number; chars: number } {
  let take = Math.min(EXTRACT_INPUT_CHARS, text.length - offset);
  for (;;) {
    let end = offset + take;
    if (
      end < text.length &&
      end > offset &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 &&
      text.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    const chunk = text.slice(offset, end);
    const chars = escapeFenceText(chunk).length;
    if (chars <= EXTRACT_INPUT_CHARS) {
      return { text: chunk, end, chars };
    }
    take = Math.max(1, Math.floor((take * EXTRACT_INPUT_CHARS) / chars));
  }
}

/**
 * Splits events into calls of at most `EXTRACT_BATCH` events and
 * `EXTRACT_INPUT_CHARS` characters of quoted text. An event that cannot fit
 * in a call by itself is split across calls and is never truncated.
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
    if (event.text.length === 0) {
      if (current.length >= EXTRACT_BATCH) flush();
      current.push(event);
      continue;
    }
    let offset = 0;
    while (offset < event.text.length) {
      const chunk = fittedEventChunk(event.text, offset);
      if (
        current.length >= EXTRACT_BATCH ||
        chars + chunk.chars > EXTRACT_INPUT_CHARS
      ) {
        flush();
      }
      current.push(
        offset === 0 && chunk.end === event.text.length
          ? event
          : { ...event, text: chunk.text },
      );
      chars += chunk.chars;
      offset = chunk.end;
    }
  }
  flush();
  return { batches, dropped };
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function estimateTokens(messages: readonly { content: string }[]): number {
  return messages.reduce(
    (sum, message) =>
      sum + Math.ceil(utf8Length(message.content) / CHARS_PER_TOKEN) +
      MESSAGE_FRAMING_TOKENS,
    0,
  );
}

function isToolCallRejection(error: PortError): boolean {
  return error.code === "not_supported" && error.message.includes(TOOL_CALL_MARK);
}

function isUsageValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function llmResponseFault(field: string): never {
  throw new PortError(
    "contract_mismatch",
    `llm response ${field} is invalid`,
    false,
  );
}

/**
 * The LLM is a replaceable port, so its return value is checked at the port
 * boundary before producer code reads it. A malformed return is a permanent
 * contract fault, not an outage that should make the same batch retry forever.
 */
function checkedLlmResponse(value: unknown): LlmResponse {
  const response = isPlainObject(value) ? value : llmResponseFault("value");
  const text = response["text"];
  if (typeof text !== "string" || text.length > MAX_LLM_RESPONSE_CHARS) {
    llmResponseFault("text");
  }
  const model = response["model"];
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    model.length > MAX_MODEL_NAME_CHARS
  ) {
    llmResponseFault("model");
  }
  const usage = response["usage"];
  if (
    !isPlainObject(usage) ||
    !isUsageValue(usage["input_tokens"]) ||
    !isUsageValue(usage["output_tokens"])
  ) {
    llmResponseFault("usage");
  }
  return {
    text,
    model,
    usage: {
      input_tokens: usage["input_tokens"],
      output_tokens: usage["output_tokens"],
    },
  };
}

type CallOutcome =
  | { kind: "ok"; response: LlmResponse }
  | { kind: "rejected"; reason: RejectReason }
  | { kind: "unavailable"; reason: string };

async function callModel(
  llm: LlmPort,
  messages: ReturnType<typeof buildExtractionMessages>,
  maxOutputTokens: number,
  deadlineMs: number,
): Promise<CallOutcome> {
  try {
    const response = checkedLlmResponse(
      await llm.complete({
        messages,
        max_output_tokens: maxOutputTokens,
        deadline_ms: deadlineMs,
      }),
    );
    return { kind: "ok", response };
  } catch (error) {
    if (error instanceof PortError) {
      if (isToolCallRejection(error)) {
        return { kind: "rejected", reason: "tool_call_in_response" };
      }
      if (error.code === "budget_exhausted") {
        return { kind: "rejected", reason: "budget_exhausted" };
      }
      if (PERMANENT_LLM_ERRORS.has(error.code)) throw error;
      // Only the code is surfaced; a provider message never reaches a receipt.
      return { kind: "unavailable", reason: `llm ${error.code}` };
    }
    return { kind: "unavailable", reason: "llm error" };
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
      const input = validateProduceInput(rawInput);
      const usage: { -readonly [K in keyof ModelUsage]: ModelUsage[K] } = {
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
      };
      const claims: ClaimDraft[] = [];
      const { batches, dropped } = planBatches(input.events);
      for (const item of dropped) drop(item);

      // A zero/insufficient call or output budget must be rejected before any
      // prompt is materialized. Besides avoiding needless work, this prevents
      // repeated context from becoming an allocation multiplier.
      if (
        batches.length > input.budget.max_calls ||
        batches.length > input.budget.max_output_tokens
      ) {
        return { status: "rejected", reason: "budget_exhausted", usage };
      }

      const predicates = new Set(input.context.predicates);
      const knownSubjects = new Set(
        input.context.subjects.map((subject) => subject.subject_id),
      );
      const messagesForBatch = (
        batch: Batch,
        nonce: string,
      ): ReturnType<typeof buildExtractionMessages> => {
        const additionalSubjects = new Map<string, SubjectRef>();
        for (const event of batch.events) {
          for (const subject of event.subjects) {
            if (
              !knownSubjects.has(subject.subject_id) &&
              !additionalSubjects.has(subject.subject_id)
            ) {
              additionalSubjects.set(subject.subject_id, subject);
            }
          }
        }
        return buildExtractionMessages(
          {
            events: batch.events,
            subjects:
              additionalSubjects.size === 0
                ? input.context.subjects
                : [
                    ...input.context.subjects,
                    ...additionalSubjects.values(),
                  ],
            known_claims: input.context.known_claims,
            predicates: input.context.predicates,
          },
          nonce,
        );
      };

      // Preflight the whole run so a later batch cannot fail a predictable
      // budget check after earlier claims were produced. Only one prompt is
      // live at a time; messages are rebuilt with a fresh nonce for the call.
      let plannedInputTokens = 0;
      const plannedInputByBatch: number[] = [];
      for (const batch of batches) {
        const estimate = estimateTokens(
          messagesForBatch(batch, PREFLIGHT_FENCE_NONCE),
        );
        plannedInputByBatch.push(estimate);
        plannedInputTokens += estimate;
        if (plannedInputTokens > input.budget.max_input_tokens) {
          return { status: "rejected", reason: "budget_exhausted", usage };
        }
      }

      let remainingPlannedInputTokens = plannedInputTokens;
      for (const [index, batch] of batches.entries()) {
        assertOpen();
        if (
          usage.input_tokens + remainingPlannedInputTokens >
          input.budget.max_input_tokens
        ) {
          return { status: "rejected", reason: "budget_exhausted", usage };
        }

        // Budgets are charged before the request, never after.
        const remainingOutput =
          input.budget.max_output_tokens - usage.output_tokens;
        const laterCalls = batches.length - index - 1;
        if (remainingOutput - laterCalls < 1) {
          return { status: "rejected", reason: "budget_exhausted", usage };
        }
        const maxOutput = Math.min(
          EXTRACT_MAX_OUTPUT_TOKENS,
          remainingOutput - laterCalls,
        );
        const nonce = newFenceNonce();
        const messages = messagesForBatch(batch, nonce);
        const outcome = await callModel(llm, messages, maxOutput, config.deadline_ms);
        usage.calls += 1;
        if (outcome.kind === "unavailable") {
          return { status: "unavailable", reason: outcome.reason };
        }
        if (outcome.kind === "rejected") {
          return { status: "rejected", reason: outcome.reason, usage };
        }
        usage.input_tokens += outcome.response.usage.input_tokens;
        usage.output_tokens += outcome.response.usage.output_tokens;
        if (
          usage.calls > input.budget.max_calls ||
          usage.input_tokens > input.budget.max_input_tokens ||
          usage.output_tokens > input.budget.max_output_tokens
        ) {
          return { status: "rejected", reason: "budget_exhausted", usage };
        }
        remainingPlannedInputTokens -= plannedInputByBatch[index]!;

        const text = outcome.response.text;
        if (hasFenceLeak(text, nonce)) {
          return { status: "rejected", reason: "fence_leak", usage };
        }
        const parsed = parseExtractResponse(text);
        if (!parsed.ok) {
          ctx.logger({
            level: "warn",
            message: "extract_schema_invalid",
            detail: { detail: parsed.detail },
          });
          return { status: "rejected", reason: "schema_invalid", usage };
        }

        const batchEventIds = new Set(batch.events.map((event) => event.event_id));
        const batchSubjects = new Set(knownSubjects);
        for (const event of batch.events) {
          for (const subject of event.subjects) batchSubjects.add(subject.subject_id);
        }
        const sources = batch.events.map((event) => event.text);

        for (const draft of parsed.claims) {
          if (!draft.event_ids.every((id) => batchEventIds.has(id))) {
            return { status: "rejected", reason: "provenance_not_cited", usage };
          }
          if (containsVerbatimCapture(draft.body, sources)) {
            ctx.logger({
              level: "warn",
              message: "extract_schema_invalid",
              detail: { detail: "body reproduces quoted text verbatim" },
            });
            return { status: "rejected", reason: "schema_invalid", usage };
          }
        }
        for (const draft of parsed.claims) {
          if (!predicates.has(draft.predicate)) {
            const item: DroppedDraft = {
              reason: "unknown_predicate",
              event_ids: [...draft.event_ids],
              ...(PREDICATE.test(draft.predicate)
                ? { predicate: draft.predicate }
                : {}),
            };
            dropped.push(item);
            drop(item);
            continue;
          }
          if (!batchSubjects.has(draft.subject)) {
            const item: DroppedDraft = {
              reason: "unknown_subject",
              event_ids: [...draft.event_ids],
            };
            dropped.push(item);
            drop(item);
            continue;
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
