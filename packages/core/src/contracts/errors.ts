/**
 * The one error type every connector throws. It lives in core rather than in
 * `@kizuki/connectors` so a connector package can import it without depending
 * on the registry that imports the connector back.
 */
export const KIZUKI_ERROR_CODES = [
  "unknown_connector",
  "parse_error",
  "missing_secret",
  "misconfigured",
  "unauthenticated",
  "unreachable",
  "rate_limited",
  "protocol",
  "provider_error",
  "timeout",
  "not_supported",
  "unavailable",
  "malformed_record",
  "source_schema",
  "corrupted",
] as const;
export type KizukiErrorCode = (typeof KIZUKI_ERROR_CODES)[number];

const RETRYABLE_BY_DEFAULT: ReadonlySet<KizukiErrorCode> = new Set([
  "timeout",
  "unreachable",
  "rate_limited",
]);

export function isKizukiErrorCode(value: unknown): value is KizukiErrorCode {
  return (
    typeof value === "string" &&
    (KIZUKI_ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface KizukiErrorOptions extends ErrorOptions {
  retryable?: boolean;
  /** Host-safe diagnostic; never captured text, secrets, or provider dumps. */
  detail?: string;
}

export class KizukiError extends Error {
  readonly code: KizukiErrorCode;
  readonly retryable: boolean;
  readonly detail: string | undefined;

  constructor(
    code: KizukiErrorCode,
    message: string,
    options?: KizukiErrorOptions,
  ) {
    super(message, options);
    this.name = "KizukiError";
    this.code = code;
    this.retryable = options?.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.detail = options?.detail;
  }
}
