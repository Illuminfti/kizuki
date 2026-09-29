export const CORRECT_ERROR_CODES = [
  "writer_busy",
  "target_required",
  "statement_invalid",
  "claim_unknown",
  "claim_not_live",
  "ledger_rejected",
  "tool_not_granted",
  "below_authority",
  "budget_exhausted",
  "unsupported_assertion",
  "correction_refused",
  "source_access_denied",
] as const;
export type CorrectErrorCode = (typeof CORRECT_ERROR_CODES)[number];

/** Stable, actionable, and never carries the owner's statement. */
export class CorrectError extends Error {
  override readonly name = "CorrectError";
  /** The refusal without the class and code prefix, for an adapter that words it itself. */
  readonly detail: string;

  constructor(
    readonly code: CorrectErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`CorrectError: ${code}: ${message}`, options);
    this.detail = message;
  }
}
