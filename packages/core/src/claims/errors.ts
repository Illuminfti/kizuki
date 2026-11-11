export const CLAIM_ERROR_CODES = [
  "identity_unsupported",
  "migration_required",
  "provenance_unresolved",
  "schema_invalid",
  "unknown_predicate",
  "space_mismatch",
  "world_cycle",
  "world_endpoint_kind",
  "world_cycle",
  "world_object_kind",
  "world_polarity",
  "world_vocabulary_value",
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

/**
 * One support's recomputed admission identity differs from the immutable one
 * already recorded under the same support key. It names only the differing
 * identity fields, never their values: the admission carries captured text.
 */
export class AdmissionConflictError extends ClaimError {
  constructor(readonly support_key: string, readonly fields: readonly string[]) {
    super("schema_invalid", "claim/v2 support conflicts with immutable admission");
  }
}
