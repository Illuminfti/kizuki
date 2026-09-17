import { SENSITIVITY_ORDER, isSensitivity } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { rfc3339Instant } from "../agents/time";
import { isRfc3339 } from "../util/time";

/**
 * Integer UTC seconds plus nanoseconds for an RFC3339 column. Leap second
 * `:60` maps to nanosecond 999999999 of minute 59. `column` MUST be a column
 * reference; it is substituted several times, so a `?` placeholder is not
 * allowed here. `agents/time.ts` uses the same minute-preserving order for
 * grant windows.
 */
export function instantSecondSql(column: string): string {
  // Only numeric offsets have a sign six characters from the end. Z/z forms
  // fall through to zero without a second timezone-normalization expression.
  const tz = `substr(${column}, -6)`;
  // SQLite rejects offsets beyond 14 hours, but the ingress contract accepts
  // RFC3339 offsets through 23:59. Parse the wall clock as UTC and apply the
  // validated offset arithmetically so accepted rows never become SQL NULL.
  const offset = `(CAST(substr(${tz}, 2, 2) AS INTEGER) * 3600 + CAST(substr(${tz}, 5, 2) AS INTEGER) * 60)`;
  return `(unixepoch(
  replace(
    CASE
      WHEN substr(${column}, 18, 2) = '60' THEN
        substr(${column}, 1, 17) || '59Z'
      ELSE
        substr(${column}, 1, 19) || 'Z'
    END,
    't', 'T'
  )
) - CASE substr(${tz}, 1, 1)
  WHEN '+' THEN ${offset}
  WHEN '-' THEN -${offset}
  ELSE 0
END)`;
}

export function instantNanoSql(column: string): string {
  return `CASE
  WHEN substr(${column}, 18, 2) = '60' THEN 999999999
  WHEN substr(${column}, 20, 1) = '.' THEN CAST(substr((
    CASE
      WHEN lower(substr(${column}, -1)) = 'z' THEN substr(${column}, 21, length(${column}) - 21)
      ELSE substr(${column}, 21, length(${column}) - 26)
    END
  ) || '000000000', 1, 9) AS INTEGER)
  ELSE 0
END`;
}

export function instantPairSql(column: string): string {
  return `(${instantSecondSql(column)}, ${instantNanoSql(column)})`;
}

export function instantBoundPair(value: string, label: string): [number, number] {
  if (!isRfc3339(value)) {
    throw new RangeError(`${label} must be an RFC3339 timestamp`);
  }
  const parsed = rfc3339Instant(value, label);
  return [parsed.epochSecond, parsed.nanos];
}

/** Millisecond ISO form for grant-window Date comparisons. */
export function instantBound(value: string, label: string): string {
  const [seconds, nanos] = instantBoundPair(value, label);
  return new Date(seconds * 1_000 + Math.trunc(nanos / 1_000_000)).toISOString();
}

export function ceilingSql(column: string): string {
  const branches = (Object.keys(SENSITIVITY_ORDER) as Sensitivity[])
    .map((label) => `WHEN '${label}' THEN ${SENSITIVITY_ORDER[label]}`)
    .join(" ");
  return `CASE ${column} ${branches} ELSE NULL END <= ?`;
}

/** Public queries must validate policy before any shortcut or database read. */
export function requireCeiling(value: unknown): number {
  if (!isSensitivity(value)) {
    throw new RangeError("query ceiling must be public, personal, or private");
  }
  return SENSITIVITY_ORDER[value];
}
