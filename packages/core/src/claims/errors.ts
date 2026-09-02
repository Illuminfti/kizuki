export const CLAIM_ERROR_CODES = [
  "provenance_unresolved",
  "schema_invalid",
  "unknown_predicate",
  "space_mismatch",
] as const;
export type ClaimErrorCode = (typeof CLAIM_ERROR_CODES)[number];

export class ClaimError extends Error {
  override readonly name = "ClaimError";

  constructor(
    readonly code: ClaimErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`ClaimError: ${code}: ${message}`, options);
  }
}
