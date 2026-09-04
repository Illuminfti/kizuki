import { HealthReport } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";

/**
 * A single skipped or degraded record. `reason` is a stable code phrase, never
 * captured text: doctor and tests have to name the failure without echoing
 * the export.
 */
export interface ImportRecordError {
  /** Stable locator: conversation/node id or a numeric path. */
  location: string;
  code: string;
  reason: string;
}

export interface ImportParseResult {
  events: CaptureEventInput[];
  errors: ImportRecordError[];
}

export const MAX_REPORTED_ERRORS = 32;

/** Bound the examples a health report may carry; never include private text. */
export function summarizeImportErrors(
  errors: readonly ImportRecordError[],
): string {
  const counts = new Map<string, number>();
  for (const error of errors) {
    counts.set(error.code, (counts.get(error.code) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, count]) => `${code}=${count}`);
  const extra =
    errors.length > MAX_REPORTED_ERRORS
      ? `; truncated=${errors.length - MAX_REPORTED_ERRORS}`
      : "";
  return `${errors.length} record errors (${parts.join(" ")}${extra})`;
}

export function importHealthReport(opts: {
  checked_at: string;
  events: number;
  errors: readonly ImportRecordError[];
  truncated?: boolean;
}): HealthReport {
  const errorSummary =
    opts.errors.length > 0 ? summarizeImportErrors(opts.errors) : undefined;
  if (opts.errors.length > 0 || opts.truncated === true) {
    return new HealthReport({
      state: "degraded",
      checked_at: opts.checked_at,
      detail: [
        `records=${opts.events}`,
        errorSummary,
        opts.truncated === true ? "scan truncated" : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join("; "),
    });
  }
  return new HealthReport({
    state: "ok",
    checked_at: opts.checked_at,
    detail: `records=${opts.events}`,
  });
}

export function misconfiguredHealth(
  checked_at: string,
  detail: string,
): HealthReport {
  return new HealthReport({
    state: "misconfigured",
    checked_at,
    detail,
  });
}
