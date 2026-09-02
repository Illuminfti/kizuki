import {
  PRODUCER_CONTRACT,
  PortError,
  validatePortDescriptor,
} from "@kizuki/core";
import type {
  ClaimDraft,
  LlmPort,
  PortContext,
  PortDescriptor,
  PortFactory,
  PortHealth,
  ProduceInput,
  ProduceResult,
  ProduceStop,
  ProducerPort,
} from "@kizuki/core";
import { runBatch } from "./produce-call";
import type { Tally } from "./produce-call";
import { validateInput } from "./produce-input";
import { batchEvents } from "./prompt";

export const MODEL_PRODUCER_ID = "kizuki.producer.model";

export const MODEL_PRODUCER: PortDescriptor = validatePortDescriptor({
  id: MODEL_PRODUCER_ID,
  kind: "producer",
  contract: PRODUCER_CONTRACT,
  // The minor this implementation provides, written out rather than read
  // from the contract: the next additive field must be a deliberate edit
  // here, or the descriptor would promise a feature nothing implements.
  contract_minor: 1,
  supports: ["model"],
  // The implementation lives in a workspace package a distribution can leave
  // out, and core cannot import it, so a host is told which package to have.
  optional_package: "@kizuki/llm",
  requires_lease: false,
});

/**
 * The minor at which a model port reports what a call put on the wire
 * (RFC 0002 §3.3). Below it a retried call cannot be told from a single
 * request, so one is charged and `health` says the rail is degraded.
 */
const LLM_ATTEMPTS_MINOR = 1;
const LLM_LAGS =
  "the model port reports no attempts, so a retried call is charged as one request";

/** Registry-shaped names one run carries back, so a log line stays small. */
const MAX_DROPPED_PREDICATES = 32;
/** Batches a run may put back split in two before it gives up on one. */
const MAX_SPLIT_RETRIES = 4;

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
    const lagging =
      this.llm.descriptor.contract_minor < LLM_ATTEMPTS_MINOR ? [LLM_LAGS] : [];
    if (upstream.status === "ready") {
      const detail = {
        llm: this.llm.descriptor.id,
        model_ref: this.llm.model_ref,
      };
      return lagging.length === 0
        ? { status: "ready", detail }
        : { status: "degraded", degraded: lagging, detail };
    }
    if (upstream.status === "degraded") {
      return {
        status: "degraded",
        degraded: [...upstream.degraded, ...lagging],
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
    const truncated = new Set<string>();
    const unknownPredicates = new Set<string>();
    let stop: ProduceStop | null = null;

    // A batch may be put back split in two, so the queue is walked by index
    // rather than iterated.
    const pending = batchEvents(input.events);
    let splits = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const batch = pending[index] ?? [];
      const step = await runBatch(this.llm, batch, input, usage, predicates);
      if ("stop" in step) {
        if (
          step.stop.status === "rejected" &&
          step.stop.reason === "schema_invalid" &&
          batch.length > 1 &&
          splits < MAX_SPLIT_RETRIES
        ) {
          // An answer this reader will not take may be the size of the batch
          // rather than the endpoint: a reply cut off at the token limit
          // reads exactly like a malformed one. Halving the batch is the one
          // thing that can make the same records answerable, and without it
          // every later pass refuses the same batch the same way and the
          // records behind it are never extracted.
          splits += 1;
          const half = Math.ceil(batch.length / 2);
          pending.splice(index, 1, batch.slice(0, half), batch.slice(half));
          index -= 1;
          continue;
        }
        stop = step.stop;
        break;
      }
      for (const predicate of step.outcome.unknown_predicates) {
        if (unknownPredicates.size >= MAX_DROPPED_PREDICATES) break;
        unknownPredicates.add(predicate);
      }
      claims.push(...step.outcome.claims);
      // Only the events this call carried to their end: a record split across
      // calls is covered by the last of them, never by the first.
      covered.push(...step.prompt.covered_event_ids);
      for (const id of step.prompt.truncated_event_ids) truncated.add(id);
    }

    // A rejection is scoped to one call (RFC 0002 §4.2). Batches that already
    // answered are handed back with the events they cover, so the caller
    // advances exactly that far and re-reads the rest on its next pass.
    if (stop !== null && covered.length === 0) {
      return stop.status === "unavailable"
        ? { status: "unavailable", reason: stop.reason, usage: { ...usage } }
        : { status: "rejected", reason: stop.reason, usage: { ...usage } };
    }
    // A record split across calls is cited by a claim from its first call,
    // and the call that would have carried its last piece may never have gone
    // out. Such a claim rests on evidence the run never finished sending, and
    // its record stays uncovered, so the next pass re-reads it and produces
    // the claim again: it must not reach a writer from here.
    const coveredIds = new Set(covered);
    const carried = claims.filter((claim) =>
      claim.event_ids.every((id) => coveredIds.has(id)),
    );
    if (stop !== null) {
      this.context.logger({
        level: "warn",
        message: "the run stopped before the last batch",
        detail: {
          status: stop.status,
          covered_events: covered.length,
          dropped_claims: claims.length - carried.length,
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
    if (truncated.size > 0) {
      this.context.logger({
        level: "warn",
        message: "quoted part of a record that is longer than a run can carry",
        detail: { count: truncated.size },
      });
    }
    return {
      status: "ok",
      claims: carried,
      usage: { ...usage },
      covered_event_ids: covered,
      dropped_predicates: [...unknownPredicates].sort(),
      truncated_event_ids: [...truncated],
      // The stop travels on the result, not only to the logger: a caller has
      // to be able to count an outage and degrade the rail, and a run that
      // covered a prefix must not read as one that covered everything.
      stopped: stop,
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
