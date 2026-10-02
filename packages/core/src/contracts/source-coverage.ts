import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";

/** Counts from the connector's existing walk, never a second inventory. */
export interface ScanCoverage {
  /** Eligible records examined, including failed reads. */
  scanned: number;
  /** Matching entries, not files hidden below excluded directories. */
  excluded: { rule: string; count: number }[];
  pending: number;
  /** Observed failed entries, including directories whose contents are unknown. */
  failed: number;
  truncated: boolean;
  /** Content this connector does not capture. */
  content_exclusions: string[];
}

/** Persisted with the checkpoint, atomically with its run receipt. */
export interface PassCoverage {
  scan: ScanCoverage | null;
  last_successful_pass_at: string | null;
  last_error_class: string | null;
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const label = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);

export function parseScanCoverage(v: unknown): ScanCoverage {
  if (!isPlainObject(v) || !count(v.scanned) || !count(v.pending) || !count(v.failed) ||
      typeof v.truncated !== "boolean" || !Array.isArray(v.excluded) || v.excluded.length > 512 ||
      !v.excluded.every(r => isPlainObject(r) && label(r.rule) && count(r.count)) ||
      !Array.isArray(v.content_exclusions) || v.content_exclusions.length > 32 || !v.content_exclusions.every(label)) {
    throw new TypeError("source coverage is invalid");
  }
  return {
    scanned: v.scanned, pending: v.pending, failed: v.failed, truncated: v.truncated,
    excluded: v.excluded.map(r => ({ rule: r.rule as string, count: r.count as number })),
    content_exclusions: [...v.content_exclusions] as string[],
  };
}

export function parsePassCoverage(v: unknown): PassCoverage {
  if (!isPlainObject(v) || !(v.last_successful_pass_at === null ||
      (typeof v.last_successful_pass_at === "string" && isRfc3339(v.last_successful_pass_at))) ||
      !(v.last_error_class === null || (typeof v.last_error_class === "string" && /^[a-z_]{1,64}$/.test(v.last_error_class)))) {
    throw new TypeError("source pass coverage is invalid");
  }
  return { scan: v.scan === null ? null : parseScanCoverage(v.scan),
    last_successful_pass_at: v.last_successful_pass_at, last_error_class: v.last_error_class };
}
