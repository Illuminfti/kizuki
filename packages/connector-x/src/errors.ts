import { KizukiError } from "@kizuki/core";

export function archiveError(
  code: "misconfigured" | "parse_error" | "unavailable" | "not_supported",
  detail: string,
  _cause?: unknown,
): KizukiError {
  return new KizukiError(code, `kizuki.import-x-archive: ${detail}`, {
    retryable: code === "unavailable",
  });
}

export function errorDetail(error: unknown): string {
  if (error instanceof KizukiError) return error.message;
  return "kizuki.import-x-archive: archive could not be inspected";
}
