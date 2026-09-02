import { PortError, isPlainObject } from "@kizuki/core";
import type { LlmSpend, PortErrorCode, RejectReason } from "@kizuki/core";

/** A refused answer is an answer: the endpoint served at least one request. */
const ONE_REQUEST: LlmSpend = {
  attempts: 1,
  input_tokens: 0,
  output_tokens: 0,
};

/**
 * A failure that also reports what the call had already put on the wire, so a
 * caller with a budget charges what it really cost rather than the single
 * request it could infer (`kizuki.llm/v1` minor 1).
 */
export class LlmFailure extends PortError {
  readonly spend: LlmSpend;

  constructor(
    code: PortErrorCode,
    message: string,
    retryable: boolean,
    spend: LlmSpend,
    options?: ErrorOptions,
  ) {
    super(code, message, retryable, options);
    this.spend = spend;
  }
}

/**
 * A provider answer this package refuses to hand on. It carries the
 * producer-level reject reason so `kizuki.producer.model` can report the
 * tri-state without parsing a message string. The `PortError` code is
 * `unavailable` rather than `not_supported`, which RFC 0002 §3.3 reserves for
 * calling a capability a port never declared — a bug in core, not an endpoint
 * answering something this package will not carry.
 */
export class LlmRejection extends LlmFailure {
  readonly reason: RejectReason;

  constructor(
    reason: RejectReason,
    message: string,
    spend: LlmSpend = ONE_REQUEST,
  ) {
    super("unavailable", message, false, spend);
    this.reason = reason;
  }
}

/** The reject reason of a refused answer, or `null` for any other failure. */
export function rejectionOf(error: unknown): RejectReason | null {
  return error instanceof LlmRejection ? error.reason : null;
}

function whole(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

/**
 * What a failed call spent, when the port that failed reports it. Read off
 * the error rather than off the class, because the producer is handed
 * whichever `kizuki.llm/v1` implementation a host bound, and validated like
 * anything else crossing a port boundary.
 */
export function spendOf(error: unknown): LlmSpend | null {
  if (typeof error !== "object" || error === null) return null;
  const spend = (error as { spend?: unknown }).spend;
  if (!isPlainObject(spend)) return null;
  const attempts = whole(spend["attempts"]);
  const input = whole(spend["input_tokens"]);
  const output = whole(spend["output_tokens"]);
  if (attempts === null || input === null || output === null) return null;
  return { attempts, input_tokens: input, output_tokens: output };
}

export function configError(message: string): never {
  throw new PortError("config_invalid", message, false);
}

export function reject(reason: RejectReason, message: string): never {
  throw new LlmRejection(reason, message);
}

/** Re-raise a refused answer once the call knows what it spent. */
export function refusedAfter(error: unknown, spend: LlmSpend): unknown {
  return error instanceof LlmRejection
    ? new LlmRejection(error.reason, error.message, spend)
    : error;
}
