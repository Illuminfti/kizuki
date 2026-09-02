/**
 * The one error type every connector throws. It lives in core rather than in
 * `@kizuki/connectors` so a connector package can import it without depending
 * on the registry that imports the connector back.
 */
export type KizukiErrorCode =
  | "unknown_connector"
  | "parse_error"
  | "missing_secret"
  | "misconfigured"
  | "unauthenticated"
  | "unreachable"
  | "rate_limited"
  | "protocol";

export class KizukiError extends Error {
  readonly code: KizukiErrorCode;

  constructor(code: KizukiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KizukiError";
    this.code = code;
  }
}
