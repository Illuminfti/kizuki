export type LlmErrorCode =
  | "unconfigured"
  | "malformed_config"
  | "unknown_key"
  | "bad_value"
  | "bad_base_url"
  | "cloud_not_allowed"
  | "insecure_remote"
  | "plaintext_key"
  | "bad_secret_ref"
  | "missing_key"
  | "key_file_permissions"
  | "budget_exhausted"
  | "timeout"
  | "network"
  | "redirect"
  | "http_error"
  | "response_too_large"
  | "bad_response";

/**
 * Every failure of the producer is one of these codes with a closed-form
 * message. Messages never carry captured text, model output, response bodies
 * or secrets, so they are safe on stderr, in receipts, and in tests.
 */
export class LlmError extends Error {
  override name = "LlmError";
  readonly code: LlmErrorCode;
  readonly status: number | null;

  constructor(code: LlmErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status ?? null;
  }
}
