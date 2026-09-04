export type ScreenpipeErrorCode =
  | "misconfigured"
  | "schema_mismatch"
  | "locked"
  | "parse_error"
  | "reset_detected"
  | "not_supported"
  | "closed";

export class ScreenpipeConnectorError extends Error {
  readonly code: ScreenpipeErrorCode;

  constructor(
    code: ScreenpipeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScreenpipeConnectorError";
    this.code = code;
  }
}
