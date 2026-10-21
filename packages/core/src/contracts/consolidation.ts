import { isPlainObject } from "../util/validate";
import { hasFenceLeak, hasParsedFenceLeak } from "../producer/fence";
import { scrubText } from "../producer/scrub";

export const CONSOLIDATION_RESPONSE_SCHEMA = "kizuki.consolidation-response/v1";
export const CONSOLIDATION_TEXT_LIMIT = 1_200;
export type ConsolidationOutcome =
  | { readonly status: "complete"; readonly summary: string | null }
  | { readonly status: "empty" | "rejected" | "partial" | "truncated" | "unavailable" | "cancelled" };

/** Closed response grammar. A complete null is intentional; an empty body is not. */
export function parseConsolidationResponse(text: string, nonce: string): ConsolidationOutcome {
  if (text.trim().length === 0) return { status: "empty" };
  if (text.length > 16_384) return { status: "truncated" };
  if (hasFenceLeak(text, nonce)) return { status: "rejected" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { status: "rejected" }; }
  if (hasParsedFenceLeak(parsed, nonce) || !isPlainObject(parsed)) return { status: "rejected" };
  if (parsed.schema !== CONSOLIDATION_RESPONSE_SCHEMA) return { status: "rejected" };
  if (parsed.status === "partial") return { status: "partial" };
  if (parsed.status === "truncated") return { status: "truncated" };
  if (Object.keys(parsed).sort().join(",") !== "schema,status,summary" || parsed.status !== "complete") return { status: "rejected" };
  if (parsed.summary === null) return { status: "complete", summary: null };
  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0 || parsed.summary.length > CONSOLIDATION_TEXT_LIMIT) return { status: "rejected" };
  // Provider text is untrusted too. Do not admit generated credentials or controls.
  if (scrubText(parsed.summary).redactions.length > 0) return { status: "rejected" };
  return { status: "complete", summary: parsed.summary.trim() };
}

export interface ConsolidationConfig {
  readonly max_handles_per_pass: number;
  readonly max_calls_per_pass: number;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_pass_seconds: number;
  readonly max_calls_per_day: number;
  readonly max_output_tokens_per_day: number;
}
export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = Object.freeze({
  max_handles_per_pass: 8, max_calls_per_pass: 2, max_input_tokens: 8_192,
  max_output_tokens: 1_024, max_pass_seconds: 120, max_calls_per_day: 64,
  max_output_tokens_per_day: 65_536,
});
export const CONSOLIDATION_BOUNDS: Readonly<Record<keyof ConsolidationConfig, readonly [number, number]>> = {
  max_handles_per_pass: [1, 256], max_calls_per_pass: [0, 32], max_input_tokens: [256, 32_768],
  max_output_tokens: [64, 4_096], max_pass_seconds: [1, 600], max_calls_per_day: [0, 512],
  max_output_tokens_per_day: [0, 2_097_152],
};
export function consolidationConfig(value: unknown): ConsolidationConfig {
  const table = isPlainObject(value) ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_CONSOLIDATION_CONFIG).map(([key, fallback]) => {
    const candidate = table[key], [min, max] = CONSOLIDATION_BOUNDS[key as keyof ConsolidationConfig];
    return [key, typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= min && candidate <= max ? candidate : fallback];
  })) as unknown as ConsolidationConfig;
}

export const CONSOLIDATION_OUTCOMES = ["complete", "empty", "rejected", "partial", "truncated", "unavailable", "cancelled", "discarded"] as const;
export interface ConsolidationRunReport {
  readonly handles: number;
  readonly calls: number;
  readonly completed: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** Reservations plus any observed overage; unknown usage retains its reservation. */
  readonly output_tokens_charged: number;
  readonly usage_unknown: boolean;
  readonly outcomes: Readonly<Partial<Record<(typeof CONSOLIDATION_OUTCOMES)[number], number>>>;
}
/** Optional on older receipts. Invalid new reports must not be presented as verified zero usage. */
export function parseConsolidationRunReport(value: unknown): ConsolidationRunReport | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || !isPlainObject(value.outcomes) || typeof value.usage_unknown !== "boolean") throw new Error("invalid consolidation usage report");
  const counters = ["handles", "calls", "completed", "input_tokens", "output_tokens", "output_tokens_charged"] as const;
  if (counters.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0) ||
      Object.keys(value).sort().join(",") !== [...counters, "usage_unknown", "outcomes"].sort().join(",") ||
      Object.entries(value.outcomes).some(([key, n]) => !CONSOLIDATION_OUTCOMES.includes(key as never) || !Number.isSafeInteger(n) || (n as number) < 0)) throw new Error("invalid consolidation usage report");
  return value as unknown as ConsolidationRunReport;
}
