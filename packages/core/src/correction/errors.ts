export const CORRECT_ERROR_CODES = [
  "target_required",
  "statement_invalid",
  "claim_unknown",
  "claim_not_live",
  "ledger_rejected",
  "tool_not_granted",
  "below_authority",
] as const;
export type CorrectErrorCode = (typeof CORRECT_ERROR_CODES)[number];

/** Stable, actionable, and never carries the owner's statement. */
export class CorrectError extends Error {
  override readonly name = "CorrectError";

  constructor(
    readonly code: CorrectErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`CorrectError: ${code}: ${message}`, options);
  }
}
