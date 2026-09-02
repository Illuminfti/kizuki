import { PortError } from "@kizuki/core";
import type { RejectReason } from "@kizuki/core";

/**
 * A provider answer this package refuses to hand on. It is a `PortError` so
 * any host sees the contract's failure shape, and it carries the
 * producer-level reject reason so `kizuki.producer.model` can report the
 * tri-state without parsing a message string.
 */
export class LlmRejection extends PortError {
  readonly reason: RejectReason;

  constructor(reason: RejectReason, message: string) {
    super("not_supported", message, false);
    this.reason = reason;
  }
}

/** The reject reason of a refused answer, or `null` for any other failure. */
export function rejectionOf(error: unknown): RejectReason | null {
  return error instanceof LlmRejection ? error.reason : null;
}

export function configError(message: string): never {
  throw new PortError("config_invalid", message, false);
}

export function reject(reason: RejectReason, message: string): never {
  throw new LlmRejection(reason, message);
}
