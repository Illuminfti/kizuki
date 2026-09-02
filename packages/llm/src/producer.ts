import {
  PRODUCER_CONTRACT,
  PRODUCER_CONTRACT_MINOR,
  PortError,
  isPlainObject,
  validatePortDescriptor,
} from "@kizuki/core";
import type {
  ClaimDraft,
  LlmPort,
  LlmResponse,
  PortContext,
  PortDescriptor,
  PortFactory,
  PortHealth,
  ProduceInput,
  ProduceResult,
  ProducerPort,
  QuotedEvent,
} from "@kizuki/core";
import { configError, rejectionOf } from "./errors";
import { parseExtractResponse } from "./extract";
import type { ExtractOutcome } from "./extract";
import { estimateTokens } from "./llm-port";
import {
  batchEvents,
  buildExtractPrompt,
  leaksFence,
  quoteNonce,
} from "./prompt";

export const MODEL_PRODUCER_ID = "kizuki.producer.model";

export const MODEL_PRODUCER: PortDescriptor = validatePortDescriptor({
  id: MODEL_PRODUCER_ID,
  kind: "producer",
  contract: PRODUCER_CONTRACT,
  contract_minor: PRODUCER_CONTRACT_MINOR,
  supports: ["model"],
  requires_lease: false,
  optional_package: "@kizuki/llm",
});

const MAX_EVENTS = 256;
const MAX_SUBJECTS = 256;
const MAX_KNOWN_CLAIMS = 256;
const MAX_PREDICATES = 512;
const MAX_OUTPUT_TOKENS_PER_CALL = 2_048;
const CALL_DEADLINE_MS = 60_000;

/** `ModelUsage` is readonly on the wire; this is the tally behind it. */
interface Tally {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

function requireWholeNumber(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    configError(`producer input ${name} must be a whole number`);
  }
}

function quotedEvent(value: unknown): QuotedEvent {
  if (
    !isPlainObject(value) ||
    typeof value["event_id"] !== "string" ||
    value["event_id"].length === 0 ||
    value["event_id"].length > 200 ||
    typeof value["connector_id"] !== "string" ||
    typeof value["occurred_at"] !== "string" ||
    typeof value["observed_at"] !== "string" ||
    typeof value["text"] !== "string" ||
    !Array.isArray(value["subjects"]) ||
    (value["taint"] !== "untrusted" && value["taint"] !== "owner")
  ) {
    configError("producer input carries an invalid quoted event");
  }
  return value as unknown as QuotedEvent;
}

function validateInput(input: ProduceInput): void {
  if (!isPlainObject(input)) configError("producer input must be an object");
  if (!Array.isArray(input.events) || input.events.length > MAX_EVENTS) {
    configError(`producer input must carry at most ${MAX_EVENTS} events`);
  }
  for (const event of input.events) quotedEvent(event);

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
    !context.predicates.every(
      (predicate) => typeof predicate === "string" && predicate.length > 0,
    )
  ) {
    configError("producer input context is invalid");
  }

  const budget = input.budget;
  if (!isPlainObject(budget)) configError("producer input budget is invalid");
  requireWholeNumber(budget.max_calls, "budget.max_calls");
  requireWholeNumber(budget.max_input_tokens, "budget.max_input_tokens");
  requireWholeNumber(budget.max_output_tokens, "budget.max_output_tokens");
}

/**
 * `kizuki.producer/v1` over a model. It holds no database handle, no
 * filesystem handle and no network handle other than the LLM port it was
 * given: a `ProduceInput` goes in and a `ProduceResult` comes out, so there
 * is no code path from captured text to anything that acts (RFC 0002 §10.1).
 */
export class ModelProducer implements ProducerPort {
  readonly descriptor = MODEL_PRODUCER;

  private readonly context: PortContext;
  private readonly llm: LlmPort;
  private closed = false;

  constructor(context: PortContext, llm: LlmPort) {
    this.context = context;
    this.llm = llm;
  }

  async health(): Promise<PortHealth> {
    if (this.closed) {
      return { status: "unavailable", reason: "port is closed" };
    }
    const upstream = await this.llm.health();
    if (upstream.status === "ready") {
      return {
        status: "ready",
        detail: { llm: this.llm.descriptor.id, model_ref: this.llm.model_ref },
      };
    }
    if (upstream.status === "degraded") {
      return {
        status: "degraded",
        degraded: upstream.degraded,
        detail: { llm: this.llm.descriptor.id },
      };
    }
    return { status: "unavailable", reason: `llm port: ${upstream.reason}` };
  }

  /** The LLM port belongs to whoever bound it; closing it is not ours to do. */
  async close(): Promise<void> {
    this.closed = true;
  }

  async produce(input: ProduceInput): Promise<ProduceResult> {
    if (this.closed) {
      throw new PortError("unavailable", "port is closed", false);
    }
    validateInput(input);

    const usage: Tally = { calls: 0, input_tokens: 0, output_tokens: 0 };
    if (input.events.length === 0) {
      return { status: "ok", claims: [], usage: { ...usage } };
    }

    const predicates = new Set(input.context.predicates);
    const claims: ClaimDraft[] = [];
    const unknownPredicates = new Set<string>();

    for (const batch of batchEvents(input.events)) {
      const prompt = buildExtractPrompt(batch, input.context, quoteNonce());
      const inputTokens = estimateTokens(
        prompt.system.length + prompt.user.length,
      );
      const outputAllowance = Math.min(
        MAX_OUTPUT_TOKENS_PER_CALL,
        input.budget.max_output_tokens - usage.output_tokens,
      );
      if (
        usage.calls + 1 > input.budget.max_calls ||
        usage.input_tokens + inputTokens > input.budget.max_input_tokens ||
        outputAllowance < 1
      ) {
        return {
          status: "rejected",
          reason: "budget_exhausted",
          usage: { ...usage },
        };
      }

      let answer: LlmResponse;
      try {
        usage.calls += 1;
        usage.input_tokens += inputTokens;
        answer = await this.llm.complete({
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          max_output_tokens: outputAllowance,
          deadline_ms: CALL_DEADLINE_MS,
        });
      } catch (error) {
        const reason = rejectionOf(error);
        if (reason !== null) {
          return { status: "rejected", reason, usage: { ...usage } };
        }
        // A model that did not answer is not a model that answered nothing:
        // the caller must leave its checkpoint where it was.
        return {
          status: "unavailable",
          reason:
            error instanceof PortError
              ? error.message
              : "the model port failed",
        };
      }

      // Never under-charge: the estimate paid for the gate above, and an
      // endpoint that counted more than we did is charged the difference.
      usage.input_tokens += Math.max(
        0,
        answer.usage.input_tokens - inputTokens,
      );
      usage.output_tokens += answer.usage.output_tokens;

      if (leaksFence(answer.text, prompt.nonce)) {
        return {
          status: "rejected",
          reason: "fence_leak",
          usage: { ...usage },
        };
      }

      let outcome: ExtractOutcome;
      try {
        outcome = parseExtractResponse(
          answer.text,
          new Set(prompt.event_ids),
          predicates,
        );
      } catch (error) {
        const reason = rejectionOf(error);
        if (reason !== null) {
          return { status: "rejected", reason, usage: { ...usage } };
        }
        throw error;
      }
      for (const predicate of outcome.unknown_predicates) {
        unknownPredicates.add(predicate);
      }
      claims.push(...outcome.claims);
    }

    if (unknownPredicates.size > 0) {
      this.context.logger({
        level: "warn",
        message: "dropped claims naming predicates outside the registry",
        detail: { predicates: [...unknownPredicates].sort() },
      });
    }
    return { status: "ok", claims, usage: { ...usage } };
  }
}

/**
 * The producer cannot resolve another port on its own, so the host binds the
 * model port first and hands it in.
 */
export function modelProducer(llm: LlmPort): PortFactory<ProducerPort> {
  return (ctx) => new ModelProducer(ctx, llm);
}
