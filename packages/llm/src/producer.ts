import {
  PRODUCER_CONTRACT,
  PortError,
  isPlainObject,
  validatePortDescriptor,
} from "@kizuki/core";
import type {
  ClaimDraft,
  LlmPort,
  LlmResponse,
  LlmSpend,
  PortContext,
  PortDescriptor,
  PortFactory,
  PortHealth,
  ProduceInput,
  ProduceResult,
  ProduceStop,
  ProducerPort,
  RejectReason,
} from "@kizuki/core";
import { rejectionOf, spendOf } from "./errors";
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

/**
 * What a failed call is charged when the port it came from reports nothing:
 * a call the endpoint never answered still reached it at least once.
 */
const UNREPORTED_FAILURE: LlmSpend = {
  attempts: 1,
  input_tokens: 0,
  output_tokens: 0,
};

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

function stopFor(error: unknown): ProduceStop {
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
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .slice(0, MAX_REASON_CHARS)
    .trim();
}

/**
 * The largest answer this producer will read. The port in this package stops
 * a body at its configured `max_response_bytes`, whose ceiling this is, but
 * the producer is handed whichever implementation a host bound.
 */
const MAX_ANSWER_CHARS = 8_388_608;
const MAX_MODEL_REF_CHARS = 200;

function isWholeNumber(value: unknown, least: number): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= least
  );
}

/**
 * The model port is replaceable, so what it hands back is checked like
 * anything else crossing a port boundary rather than read blind. A reply that
 * is not the shape `kizuki.llm/v1` states is a fault in that port: reading it
 * raised a `TypeError` from the first field this package touched, and
 * flooring a nonsense token count charged a port that misreports its spend
 * nothing at all. Both leave as `contract_mismatch`, which is neither an
 * outage to retry nor an answer to reject.
 */
function checkedAnswer(answer: LlmResponse): LlmResponse {
  const fault = (what: string): never => {
    throw new PortError(
      "contract_mismatch",
      `the model port answered with ${what}`,
      false,
    );
  };
  if (!isPlainObject(answer)) fault("a value that is not an object");
  if (typeof answer.text !== "string" || answer.text.length > MAX_ANSWER_CHARS) {
    fault("no usable text");
  }
  if (
    typeof answer.model !== "string" ||
    answer.model.length === 0 ||
    answer.model.length > MAX_MODEL_REF_CHARS
  ) {
    fault("no usable model");
  }
  const usage: unknown = answer.usage;
  if (
    !isPlainObject(usage) ||
    !isWholeNumber(usage["input_tokens"], 0) ||
    !isWholeNumber(usage["output_tokens"], 0)
  ) {
    fault("a usage it cannot be charged for");
  }
  // Absent below minor 1, where a retried call cannot be told from a single
  // request and one is charged; present and malformed is a fault.
  if (answer.attempts !== undefined && !isWholeNumber(answer.attempts, 1)) {
    fault("an attempt count it cannot be charged for");
  }
  return answer;
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

    for (const batch of batchEvents(input.events)) {
      const prompt = buildExtractPrompt(batch, input.context, quoteNonce());
      // No tokenizer emits a token shorter than one character, so the length
      // of the messages is the one reservation that holds for every endpoint.
      const reserved = prompt.system.length + prompt.user.length;
      const outputAllowance = Math.min(
        MAX_OUTPUT_TOKENS_PER_CALL,
        input.budget.max_output_tokens - usage.output_tokens,
      );
      // A retry sends the same prompt again, so the input left over bounds
      // how many requests this call may make, not only how many calls remain.
      const allowance = Math.min(
        input.budget.max_calls - usage.calls,
        Math.floor(
          (input.budget.max_input_tokens - usage.input_tokens) / reserved,
        ),
      );
      if (allowance < 1 || outputAllowance < 1) {
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
          max_attempts: allowance,
        });
      } catch (error) {
        // What the port says the failed call put on the wire. Charging one
        // request for it would under-report a call that retried, and the
        // spend a run reports is the spend a receipt records.
        const spent = spendOf(error) ?? UNREPORTED_FAILURE;
        usage.calls += spent.attempts;
        usage.input_tokens += spent.input_tokens;
        usage.output_tokens += spent.output_tokens;
        stop = stopFor(error);
        break;
      }

      const checked = checkedAnswer(answer);
      // Never under-charge: what the endpoint says it counted wins over what
      // this port reserved, and a run that overran its budget stops here.
      usage.calls += checked.attempts ?? 1;
      usage.input_tokens += checked.usage.input_tokens;
      usage.output_tokens += checked.usage.output_tokens;
      if (
        usage.calls > input.budget.max_calls ||
        usage.input_tokens > input.budget.max_input_tokens ||
        usage.output_tokens > input.budget.max_output_tokens
      ) {
        stop = { status: "rejected", reason: "budget_exhausted" };
        break;
      }

      if (leaksFence(checked.text, prompt.nonce)) {
        stop = { status: "rejected", reason: "fence_leak" };
        break;
      }

      let outcome: ExtractOutcome;
      try {
        outcome = parseExtractResponse(
          checked.text,
          new Set(prompt.event_ids),
          predicates,
        );
      } catch (error) {
        // The reader raises rejections and nothing else; anything else here
        // is a defect in this package and must not read as a model outage.
        const reason = rejectionOf(error);
        if (reason === null) throw error;
        stop = { status: "rejected", reason };
        break;
      }
      for (const predicate of outcome.unknown_predicates) {
        if (unknownPredicates.size >= MAX_DROPPED_PREDICATES) break;
        unknownPredicates.add(predicate);
      }
      claims.push(...outcome.claims);
      // Only the events this call carried to their end: a record split across
      // calls is covered by the last of them, never by the first.
      covered.push(...prompt.covered_event_ids);
      for (const id of prompt.truncated_event_ids) truncated.add(id);
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
