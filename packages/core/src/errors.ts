/**
 * The one error class connector packages raise. It lives in core so a
 * provider package can depend on core alone; `@kizuki/connectors` re-exports
 * it for the registry and the conformance suite.
 */
export type KizukiErrorCode =
  | "unknown_connector"
  | "parse_error"
  | "missing_secret"
  | "misconfigured"
  | "unauthenticated"
  | "rate_limited"
  | "unreachable"
  | "provider_error";

export class KizukiError extends Error {
  readonly code: KizukiErrorCode;

  constructor(code: KizukiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KizukiError";
    this.code = code;
  }
}
