import {
  PRODUCER_CONTRACT,
  PRODUCER_CONTRACT_MINOR,
  PortError,
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
  RejectReason,
} from "@kizuki/core";
import { rejectionOf } from "./errors";
import { parseExtractResponse } from "./extract";
import type { ExtractOutcome } from "./extract";
import { validateInput } from "./produce-input";
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

const MAX_OUTPUT_TOKENS_PER_CALL = 2_048;
const MAX_DROPPED_PREDICATES = 32;
const CALL_DEADLINE_MS = 60_000;
const MAX_REASON_CHARS = 200;

/**
 * A failure the model port raises about itself rather than about an answer.
 * Reporting one of these as `unavailable` would tell the caller to hold its
 * checkpoint and try the identical batch again forever, so they leave as the
 * `PortError` they are.
 */
const PERMANENT: ReadonlySet<string> = new Set([
  "config_invalid",
  "contract_mismatch",
  "not_supported",
  "lease_required",
  "space_mismatch",
]);

/** Why a run stopped before it had worked through every batch. */
type Stop =
  | { status: "unavailable"; reason: string }
  | { status: "rejected"; reason: RejectReason };

function stopFor(error: unknown): Stop {
  const reason = rejectionOf(error);
  if (reason !== null) return { status: "rejected", reason };
  if (error instanceof PortError) {
    if (error.code === "budget_exhausted") {
      return { status: "rejected", reason: "budget_exhausted" };
    }
    if (PERMANENT.has(error.code)) throw error;
  }
  return { status: "unavailable", reason: scrubReason(error) };
}

/**
 * The reason travels into a run receipt, and a replaceable port wrote it.
 * Keep it short and printable rather than trusting whoever implemented it.
 */
function scrubReason(error: unknown): string {
  if (!(error instanceof PortError)) return "the model port failed";
  return error.message
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, MAX_REASON_CHARS)
    .trim();
}

/**
 * The model port is replaceable, so what it reports about a call is checked
 * like anything else crossing a port boundary rather than added blind.
 */
function counted(value: unknown, least: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > least
    ? value
    : least;
}

/** `ModelUsage` is readonly on the wire; this is the tally behind it. */
interface Tally {
  calls: number;
  input_tokens: number;
  output_tokens: number;
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
    const predicates = new Set(input.context.predicates);
    const claims: ClaimDraft[] = [];
    const covered: string[] = [];
    const unknownPredicates = new Set<string>();
    let stop: Stop | null = null;

    for (const batch of batchEvents(input.events)) {
      const prompt = buildExtractPrompt(batch, input.context, quoteNonce());
      // No tokenizer emits a token shorter than one character, so the length
      // of the messages is the one reservation that holds for every endpoint.
      const reserved = prompt.system.length + prompt.user.length;
      const outputAllowance = Math.min(
        MAX_OUTPUT_TOKENS_PER_CALL,
        input.budget.max_output_tokens - usage.output_tokens,
      );
      if (
        usage.calls >= input.budget.max_calls ||
        usage.input_tokens + reserved > input.budget.max_input_tokens ||
        outputAllowance < 1
      ) {
        stop = { status: "rejected", reason: "budget_exhausted" };
        break;
      }

      let answer: LlmResponse;
      try {
        answer = await this.llm.complete({
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          max_output_tokens: outputAllowance,
          deadline_ms: CALL_DEADLINE_MS,
          // Retries are requests too: the budget counts what goes on the wire.
          max_attempts: input.budget.max_calls - usage.calls,
        });
      } catch (error) {
        // A call the endpoint never answered still reached it at least once.
        usage.calls += 1;
        stop = stopFor(error);
        break;
      }

      // Never under-charge: what the endpoint says it counted wins over what
      // this port reserved, and a run that overran its budget stops here.
      usage.calls += counted(answer.attempts, 1);
      usage.input_tokens += counted(answer.usage.input_tokens, 0);
      usage.output_tokens += counted(answer.usage.output_tokens, 0);
      if (
        usage.calls > input.budget.max_calls ||
        usage.input_tokens > input.budget.max_input_tokens ||
        usage.output_tokens > input.budget.max_output_tokens
      ) {
        stop = { status: "rejected", reason: "budget_exhausted" };
        break;
      }

      if (leaksFence(answer.text, prompt.nonce)) {
        stop = { status: "rejected", reason: "fence_leak" };
        break;
      }

      let outcome: ExtractOutcome;
      try {
        outcome = parseExtractResponse(
          answer.text,
          new Set(prompt.event_ids),
          predicates,
        );
      } catch (error) {
        stop = stopFor(error);
        break;
      }
      for (const predicate of outcome.unknown_predicates) {
        if (unknownPredicates.size >= MAX_DROPPED_PREDICATES) break;
        unknownPredicates.add(predicate);
      }
      claims.push(...outcome.claims);
      covered.push(...prompt.event_ids);
    }

    // A rejection is scoped to one call (RFC 0002 §4.2). Batches that already
    // answered are handed back with the events they cover, so the caller
    // advances exactly that far and re-reads the rest on its next pass.
    if (stop !== null && covered.length === 0) {
      return stop.status === "unavailable"
        ? { status: "unavailable", reason: stop.reason }
        : { status: "rejected", reason: stop.reason, usage: { ...usage } };
    }
    if (stop !== null) {
      this.context.logger({
        level: "warn",
        message: "the run stopped before the last batch",
        detail: {
          status: stop.status,
          covered_events: covered.length,
          ...(stop.status === "rejected" ? { reason: stop.reason } : {}),
        },
      });
    }
    if (unknownPredicates.size > 0) {
      // The names themselves came out of the model; only the count is logged.
      this.context.logger({
        level: "warn",
        message: "dropped claims naming predicates outside the registry",
        detail: { count: unknownPredicates.size },
      });
    }
    return {
      status: "ok",
      claims,
      usage: { ...usage },
      covered_event_ids: covered,
      dropped_predicates: [...unknownPredicates].sort(),
    };
  }
}

/**
 * The producer cannot resolve another port on its own, so the host binds the
 * model port first and hands it in.
 */
export function modelProducer(llm: LlmPort): PortFactory<ProducerPort> {
  return (ctx) => new ModelProducer(ctx, llm);
}
