export type KizukiErrorCode =
  | "unknown_connector"
  | "parse_error"
  | "missing_secret"
  | "misconfigured";

export class KizukiError extends Error {
  readonly code: KizukiErrorCode;

  constructor(code: KizukiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KizukiError";
    this.code = code;
  }
}
