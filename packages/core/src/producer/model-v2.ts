import type { LlmPort } from "../contracts/llm";
import { PortError, validatePortDescriptor } from "../contracts/ports";
import type { PortContext, PortDescriptor, PortHealth } from "../contracts/ports";
import { isUlid } from "../util/ulid";
import { isPlainObject, utf8ByteLength } from "../util/validate";
import {
  MAX_V2_ANCHORS_PER_ITEM,
  MAX_V2_EVENTS,
  MAX_V2_QUOTED_UTF16,
  MAX_V2_TRUSTED_REFS,
  PRODUCER_V2_CONTRACT,
  type ModelProducerV2Options,
  type ProduceInputV2,
  type ProduceResultV2,
  type ProducerV2Port,
  type TextAnchor,
  parseExtractResponseV2,
} from "../contracts/producer-v2";
import { validateProduceResult } from "./result";
import type { ProducerDiagnostic } from "../contracts/producer";
import { callModel, DEFAULT_PRODUCER_DEADLINE_MS, EXTRACT_MAX_OUTPUT_TOKENS, CHARS_PER_TOKEN, parseModelProducerConfig } from "./model";
import { hasFenceLeak, hasParsedFenceLeak, newFenceNonce } from "./fence";
import { buildExtractionV2Messages } from "./prompt-v2";

export const MODEL_PRODUCER_V2_ID = "kizuki.producer.model.v2" as const;
export const MODEL_PRODUCER_V2_DESCRIPTOR: PortDescriptor = validatePortDescriptor({ id: MODEL_PRODUCER_V2_ID, kind: "producer", contract: PRODUCER_V2_CONTRACT, contract_minor: 0, supports: ["model"], requires_lease: false, optional_package: null });
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_BUDGET_TOKENS = 1_000_000;
const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function invalid(message: string): never { throw new PortError("config_invalid", `produce input: ${message}`, false); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function anchorKey(anchor: TextAnchor): string { return `${anchor.event_id}\u0000${anchor.start_utf16}\u0000${anchor.end_utf16}`; }
function boundary(text: string, offset: number): boolean { if (offset <= 0 || offset >= text.length) return true; const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset); return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff); }
function readAnchor(value: unknown, events: ReadonlyMap<string, string>): TextAnchor | null {
  if (!isPlainObject(value) || !exact(value, ["event_id", "start_utf16", "end_utf16"]) || !isUlid(value.event_id) || !Number.isSafeInteger(value.start_utf16) || !Number.isSafeInteger(value.end_utf16)) return null;
  const eventId = value.event_id, start = value.start_utf16, end = value.end_utf16;
  if (!isUlid(eventId) || !safeInteger(start) || !safeInteger(end)) return null;
  const text = events.get(eventId);
  if (text === undefined || start < 0 || end <= start || end > text.length || !boundary(text, start) || !boundary(text, end)) return null;
  return { event_id: eventId, start_utf16: start, end_utf16: end };
}

/** Canonical closed planning boundary. It runs before fencing, prompt construction, or any model call. */
export function validateProduceInputV2(raw: unknown): ProduceInputV2 {
  if (!isPlainObject(raw) || !exact(raw, ["events", "supplied_refs", "vocabulary_refs", "predicates", "budget"])) invalid("must be an exact v2 planning input");
  const eventsRaw = raw.events;
  if (!Array.isArray(eventsRaw) || eventsRaw.length === 0 || eventsRaw.length > MAX_V2_EVENTS) invalid("events are not a bounded list");
  const events: ProduceInputV2["events"][number][] = [];
  let quoted = 0;
  for (const value of eventsRaw) {
    if (!isPlainObject(value) || !exact(value, ["event_id", "text"]) || !isUlid(value.event_id) || typeof value.text !== "string") invalid("event is invalid");
    quoted += value.text.length;
    if (value.text.length === 0 || quoted > MAX_V2_QUOTED_UTF16 || utf8ByteLength(value.text) > MAX_V2_QUOTED_UTF16 * 4) invalid("quoted event text exceeds bounds");
    events.push({ event_id: value.event_id, text: value.text });
  }
  if (new Set(events.map(event => event.event_id)).size !== events.length) invalid("event ids are not unique");
  const textByEvent = new Map(events.map(event => [event.event_id, event.text]));
  const suppliedRaw = raw.supplied_refs;
  if (!Array.isArray(suppliedRaw) || suppliedRaw.length > MAX_V2_TRUSTED_REFS) invalid("supplied refs are not bounded");
  const supplied: ProduceInputV2["supplied_refs"][number][] = [];
  for (const value of suppliedRaw) {
    if (!isPlainObject(value) || !exact(value, ["id", "anchors"]) || typeof value.id !== "string" || !TOKEN.test(value.id) || !Array.isArray(value.anchors) || value.anchors.length === 0 || value.anchors.length > MAX_V2_ANCHORS_PER_ITEM) invalid("supplied ref is invalid");
    const anchors = value.anchors.map(anchor => readAnchor(anchor, textByEvent));
    if (anchors.some(anchor => anchor === null) || new Set(anchors.map(anchor => anchorKey(anchor!))).size !== anchors.length) invalid("supplied ref anchors are invalid");
    supplied.push({ id: value.id, anchors: anchors as TextAnchor[] });
  }
  if (new Set(supplied.map(ref => ref.id)).size !== supplied.length) invalid("supplied ref ids are not unique");
  const vocabularyRaw = raw.vocabulary_refs;
  if (!Array.isArray(vocabularyRaw) || vocabularyRaw.length > MAX_V2_TRUSTED_REFS || !vocabularyRaw.every(value => typeof value === "string" && TOKEN.test(value)) || new Set(vocabularyRaw).size !== vocabularyRaw.length) invalid("vocabulary refs are invalid");
  const predicatesRaw = raw.predicates;
  if (!Array.isArray(predicatesRaw) || predicatesRaw.length > MAX_V2_TRUSTED_REFS) invalid("predicates are not bounded");
  const predicates: ProduceInputV2["predicates"][number][] = [];
  for (const value of predicatesRaw) {
    if (!isPlainObject(value) || !exact(value, ["id", "object_kinds"]) || typeof value.id !== "string" || !TOKEN.test(value.id) || !Array.isArray(value.object_kinds) || value.object_kinds.length === 0 || value.object_kinds.length > 3 || !value.object_kinds.every(kind => kind === "literal" || kind === "subject" || kind === "vocabulary") || new Set(value.object_kinds).size !== value.object_kinds.length) invalid("predicate is invalid");
    predicates.push({ id: value.id, object_kinds: value.object_kinds as ProduceInputV2["predicates"][number]["object_kinds"] });
  }
  if (new Set(predicates.map(predicate => predicate.id)).size !== predicates.length) invalid("predicate ids are not unique");
  if (!isPlainObject(raw.budget) || !exact(raw.budget, ["max_calls", "max_input_tokens", "max_output_tokens"])) invalid("budget is invalid");
  const maxCalls = raw.budget.max_calls, maxInputTokens = raw.budget.max_input_tokens, maxOutputTokens = raw.budget.max_output_tokens;
  if (!safeInteger(maxCalls) || !safeInteger(maxInputTokens) || !safeInteger(maxOutputTokens) || maxCalls < 0 || maxCalls > 1 || maxInputTokens < 0 || maxInputTokens > MAX_BUDGET_TOKENS || maxOutputTokens < 0 || maxOutputTokens > MAX_BUDGET_TOKENS) invalid("budget is invalid");
  return { events, supplied_refs: supplied, vocabulary_refs: [...vocabularyRaw], predicates, budget: { max_calls: maxCalls, max_input_tokens: maxInputTokens, max_output_tokens: maxOutputTokens } };
}

function estimate(messages: readonly { content: string }[]): number { return Math.ceil(messages.reduce((n, item) => n + item.content.length, 0) / CHARS_PER_TOKEN); }
export type ModelExtractionV2Plan = { readonly status: "ready"; readonly input: ProduceInputV2; readonly nonce: string; readonly messages: ReturnType<typeof buildExtractionV2Messages>; readonly input_tokens: number; readonly max_output_tokens: number } | { readonly status: "rejected"; readonly diagnostic: Extract<ProducerDiagnostic, { stage: "budget" }> };
/** Plans exactly one call and retains the nonce/messages whose size was budgeted. */
export function planModelExtractionV2(raw: unknown): ModelExtractionV2Plan {
  const input = validateProduceInputV2(raw);
  if (input.budget.max_calls < 1) return { status: "rejected", diagnostic: { stage: "budget", rule: "max_calls", used: 0, requested: 1, limit: input.budget.max_calls } };
  if (input.budget.max_output_tokens < 1) return { status: "rejected", diagnostic: { stage: "budget", rule: "max_output_tokens", used: 0, requested: 1, limit: input.budget.max_output_tokens } };
  const nonce = newFenceNonce(), messages = buildExtractionV2Messages(input, nonce), inputTokens = estimate(messages);
  if (inputTokens > input.budget.max_input_tokens) return { status: "rejected", diagnostic: { stage: "budget", rule: "max_input_tokens", used: 0, requested: inputTokens, limit: input.budget.max_input_tokens } };
  return { status: "ready", input, nonce, messages, input_tokens: inputTokens, max_output_tokens: Math.min(EXTRACT_MAX_OUTPUT_TOKENS, input.budget.max_output_tokens) };
}

export function createModelProducerV2Port(ctx: PortContext, options: ModelProducerV2Options): ProducerV2Port {
  const config = parseModelProducerConfig(ctx.config), llm = options?.llm;
  if (llm === undefined || typeof llm.complete !== "function") throw new PortError("config_invalid", "model producer requires a bound llm port", false);
  let closed = false;
  return {
    descriptor: MODEL_PRODUCER_V2_DESCRIPTOR,
    get model_ref() { return llm.model_ref; },
    async health(): Promise<PortHealth> { if (closed) return { status: "unavailable", reason: "producer port is closed" }; return await llm.health(); },
    async produce(raw: ProduceInputV2): Promise<ProduceResultV2> {
      if (closed) throw new PortError("unavailable", "producer port is closed", false);
      const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
      const plan = planModelExtractionV2(raw);
      if (plan.status === "rejected") return { status: "rejected", reason: "budget_exhausted", usage, diagnostic: plan.diagnostic };
      const outcome = await callModel(llm as LlmPort, plan.messages, plan.max_output_tokens, config.deadline_ms ?? DEFAULT_PRODUCER_DEADLINE_MS);
      usage.calls = 1;
      if (outcome.kind === "unavailable") return { status: "unavailable", reason: outcome.diagnostic.rule === "timeout" ? "timeout" : outcome.diagnostic.rule === "network" ? "network" : outcome.diagnostic.rule === "credentials" ? "credentials" : outcome.diagnostic.rule === "http" ? "http" : "unavailable", usage, diagnostic: outcome.diagnostic };
      if (outcome.kind === "rejected") return { status: "rejected", reason: outcome.reason, usage, diagnostic: outcome.diagnostic };
      usage.input_tokens = outcome.response.usage.input_tokens; usage.output_tokens = outcome.response.usage.output_tokens;
      if (hasFenceLeak(outcome.response.text, plan.nonce)) return { status: "rejected", reason: "fence_leak", usage };
      let decoded: unknown; try { decoded = JSON.parse(outcome.response.text); } catch { decoded = null; }
      if (decoded !== null && hasParsedFenceLeak(decoded, plan.nonce)) return { status: "rejected", reason: "fence_leak", usage };
      const parserInput = { events: plan.input.events, supplied_refs: plan.input.supplied_refs, vocabulary_refs: plan.input.vocabulary_refs, predicates: plan.input.predicates };
      const parsed = parseExtractResponseV2(outcome.response.text, parserInput);
      if (!parsed.ok) return { status: "rejected", reason: "schema_invalid", usage, diagnostic: { stage: "response", rule: "bad_response" } };
      const wire = parsed.dropped.length === 0 ? { status: "ok" as const, response: parsed.response, usage } : { status: "ok" as const, response: parsed.response, usage, dropped: parsed.dropped };
      return validateProduceResult(wire, PRODUCER_V2_CONTRACT, parserInput).result;
    },
    async close() { closed = true; },
  };
}
