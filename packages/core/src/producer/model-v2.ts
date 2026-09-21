import type { LlmPort } from "../contracts/llm";
import { PortError, validatePortDescriptor } from "../contracts/ports";
import type { PortContext, PortDescriptor, PortHealth } from "../contracts/ports";
import { PRODUCER_V2_CONTRACT, type ModelProducerV2Options, type ProduceInputV2, type ProduceResultV2, type ProducerV2Port, parseExtractResponseV2 } from "../contracts/producer-v2";
import { validateProduceResult } from "./result";
import { callModel, DEFAULT_PRODUCER_DEADLINE_MS, EXTRACT_MAX_OUTPUT_TOKENS, CHARS_PER_TOKEN, parseModelProducerConfig } from "./model";
import { hasFenceLeak, hasParsedFenceLeak, newFenceNonce } from "./fence";
import { buildExtractionV2Messages } from "./prompt-v2";

export const MODEL_PRODUCER_V2_ID = "kizuki.producer.model.v2" as const;
export const MODEL_PRODUCER_V2_DESCRIPTOR: PortDescriptor = validatePortDescriptor({ id: MODEL_PRODUCER_V2_ID, kind: "producer", contract: PRODUCER_V2_CONTRACT, contract_minor: 0, supports: ["model"], requires_lease: false, optional_package: null });

function invalid(message: string): never { throw new PortError("config_invalid", `produce input: ${message}`, false); }
function validInput(input: unknown): input is ProduceInputV2 {
  if (input === null || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return Array.isArray(value.events) && Array.isArray(value.supplied_refs) && Array.isArray(value.vocabulary_refs) && Array.isArray(value.predicates) && value.budget !== null && typeof value.budget === "object";
}
function estimate(messages: readonly { content: string }[]): number { return Math.ceil(messages.reduce((n, item) => n + item.content.length, 0) / CHARS_PER_TOKEN); }

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
      if (!validInput(raw)) invalid("is not a closed v2 planning input");
      const budget = raw.budget;
      if (!Number.isSafeInteger(budget.max_calls) || !Number.isSafeInteger(budget.max_input_tokens) || !Number.isSafeInteger(budget.max_output_tokens) || budget.max_calls < 1 || budget.max_input_tokens < 1 || budget.max_output_tokens < 1) invalid("budget is invalid");
      const nonce = newFenceNonce(), messages = buildExtractionV2Messages(raw, nonce), inputTokens = estimate(messages);
      const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
      if (budget.max_calls < 1 || inputTokens > budget.max_input_tokens) return { status: "rejected", reason: "budget_exhausted", usage, diagnostic: { stage: "budget", rule: "max_input_tokens", used: 0, requested: inputTokens, limit: budget.max_input_tokens } };
      const maxOutput = Math.min(EXTRACT_MAX_OUTPUT_TOKENS, budget.max_output_tokens);
      const outcome = await callModel(llm as LlmPort, messages, maxOutput, config.deadline_ms ?? DEFAULT_PRODUCER_DEADLINE_MS);
      usage.calls = 1;
      if (outcome.kind === "unavailable") return { status: "unavailable", reason: outcome.diagnostic.rule === "timeout" ? "timeout" : outcome.diagnostic.rule === "network" ? "network" : outcome.diagnostic.rule === "credentials" ? "credentials" : outcome.diagnostic.rule === "http" ? "http" : "unavailable", usage, diagnostic: outcome.diagnostic };
      if (outcome.kind === "rejected") return { status: "rejected", reason: outcome.reason, usage, diagnostic: outcome.diagnostic };
      usage.input_tokens = outcome.response.usage.input_tokens; usage.output_tokens = outcome.response.usage.output_tokens;
      if (hasFenceLeak(outcome.response.text, nonce)) return { status: "rejected", reason: "fence_leak", usage };
      let decoded: unknown; try { decoded = JSON.parse(outcome.response.text); } catch { decoded = null; }
      if (decoded !== null && hasParsedFenceLeak(decoded, nonce)) return { status: "rejected", reason: "fence_leak", usage };
      const parserInput = { events: raw.events, supplied_refs: raw.supplied_refs, vocabulary_refs: raw.vocabulary_refs, predicates: raw.predicates };
      const parsed = parseExtractResponseV2(outcome.response.text, parserInput);
      if (!parsed.ok) return { status: "rejected", reason: "schema_invalid", usage, diagnostic: { stage: "response", rule: "bad_response" } };
      const wire = parsed.dropped.length === 0 ? { status: "ok" as const, response: parsed.response, usage } : { status: "ok" as const, response: parsed.response, usage, dropped: parsed.dropped };
      const validated = validateProduceResult(wire, PRODUCER_V2_CONTRACT, parserInput);
      return validated.result;
    },
    async close() { closed = true; },
  };
}
