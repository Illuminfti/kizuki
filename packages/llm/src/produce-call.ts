/**
 * One extraction call: what a batch may spend, what the model port answered,
 * and what that answer is worth. The run that walks the batches is in
 * `producer.ts`; everything here is about a single request.
 */
import { PortError, isPlainObject } from "@kizuki/core";
import type {
  LlmPort,
  LlmResponse,
  LlmSpend,
  ProduceInput,
  ProduceStop,
} from "@kizuki/core";
import { rejectionOf, spendOf } from "./errors";
import { MAX_CLAIMS, MAX_CLAIM_CHARS, parseExtractResponse } from "./extract";
import type { ExtractOutcome } from "./extract";
import { buildExtractPrompt, leaksFence, quoteNonce } from "./prompt";
import type { ExtractPrompt, QuotedChunk } from "./prompt";
import { estimateTokens, requestTokens } from "./spend";
import { sanitize } from "./text";

/**
 * What a failed call is charged when the port it came from reports nothing:
 * a call the endpoint never answered still reached it at least once.
 */
const UNREPORTED_FAILURE: LlmSpend = {
  attempts: 1,
  input_tokens: 0,
  output_tokens: 0,
};

/**
 * Drafts one quoted record can honestly carry. A call is allowed room for
 * this many per block at the reader's own ceilings, so an answer this package
 * would accept is never cut off at the token limit.
 */
const CLAIMS_PER_EVENT = 4;
/** The JSON around the drafts: the object, the list and its separators. */
const ANSWER_ENVELOPE_CHARS = 256;
/**
 * The most any one call may generate, whatever the batch works out to. An
 * endpoint refuses a `max_tokens` larger than the model it serves can
 * produce, so the derived room is capped at a figure one will take.
 */
export const MAX_OUTPUT_TOKENS_PER_CALL = 8_192;
export const CALL_DEADLINE_MS = 60_000;
const MAX_REASON_CHARS = 200;


/**
 * The largest answer this producer will read. The port in this package stops
 * a body at its configured `max_response_bytes`, whose ceiling this is, but
 * the producer is handed whichever implementation a host bound.
 */
const MAX_ANSWER_CHARS = 8_388_608;
const MAX_MODEL_REF_CHARS = 200;

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

/** `ModelUsage` is readonly on the wire; this is the tally behind it. */
export interface Tally {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/** A call's answer, or the stop it ended at. */
export type BatchStep =
  | { stop: ProduceStop }
  | { prompt: ExtractPrompt; outcome: ExtractOutcome };

/**
 * What a legal answer for one call can need. A fixed ceiling smaller than
 * this cut off an honest answer for a full batch, and a cut-off reply is
 * refused as malformed - so the same batch was refused the same way on every
 * later pass and the records behind it were never extractable.
 */
export function outputCeiling(blocks: number): number {
  const drafts = Math.min(MAX_CLAIMS, Math.max(1, blocks) * CLAIMS_PER_EVENT);
  return Math.min(
    MAX_OUTPUT_TOKENS_PER_CALL,
    estimateTokens(drafts * MAX_CLAIM_CHARS + ANSWER_ENVELOPE_CHARS),
  );
}

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
  return sanitize(error.message, false).slice(0, MAX_REASON_CHARS).trim();
}

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

/**
 * One call: the prompt for a batch, what it may spend, and what came back.
 * Either an answer this package will carry or the stop it ended at; a fault
 * in the model port itself leaves as the `PortError` it is. The tally is
 * charged in place, so a stop still reports what the call had cost.
 */
export async function runBatch(
  llm: LlmPort,
  batch: readonly QuotedChunk[],
  input: ProduceInput,
  usage: Tally,
  predicates: ReadonlySet<string>,
): Promise<BatchStep> {
  const prompt = buildExtractPrompt(batch, input.context, quoteNonce());
  const outputAllowance = Math.min(
    outputCeiling(batch.length),
    input.budget.max_output_tokens - usage.output_tokens,
  );
  // What this call is expected to cost, in the unit the charge uses. The
  // messages were counted as if one character were one token, which reserved
  // about four times what an endpoint reports and refused calls a budget
  // could comfortably pay for.
  const reserved = requestTokens(prompt.system, prompt.user);
  // A retry sends the same prompt again, so the input left over bounds how
  // many requests this call may make, not only how many calls remain.
  const allowance = Math.min(
    input.budget.max_calls - usage.calls,
    Math.floor((input.budget.max_input_tokens - usage.input_tokens) / reserved),
  );
  if (allowance < 1 || outputAllowance < 1) {
    return { stop: { status: "rejected", reason: "budget_exhausted" } };
  }

  let answer: LlmResponse;
  try {
    answer = await llm.complete({
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
    // request for it would under-report a call that retried, and the spend a
    // run reports is the spend a receipt records.
    const spent = spendOf(error) ?? UNREPORTED_FAILURE;
    usage.calls += spent.attempts;
    usage.input_tokens += spent.input_tokens;
    usage.output_tokens += spent.output_tokens;
    return { stop: stopFor(error) };
  }

  const checked = checkedAnswer(answer);
  // Never under-charge: what the endpoint says it counted wins over what this
  // port reserved, and a run that overran its budget stops here.
  usage.calls += checked.attempts ?? 1;
  usage.input_tokens += checked.usage.input_tokens;
  usage.output_tokens += checked.usage.output_tokens;
  if (
    usage.calls > input.budget.max_calls ||
    usage.input_tokens > input.budget.max_input_tokens ||
    usage.output_tokens > input.budget.max_output_tokens
  ) {
    return { stop: { status: "rejected", reason: "budget_exhausted" } };
  }

  if (leaksFence(checked.text, prompt.nonce)) {
    return { stop: { status: "rejected", reason: "fence_leak" } };
  }

  try {
    return {
      prompt,
      outcome: parseExtractResponse(
        checked.text,
        new Set(prompt.event_ids),
        predicates,
      ),
    };
  } catch (error) {
    // The reader raises rejections and nothing else; anything else here is a
    // defect in this package and must not read as a model outage.
    const reason = rejectionOf(error);
    if (reason === null) throw error;
    return { stop: { status: "rejected", reason } };
  }
}
