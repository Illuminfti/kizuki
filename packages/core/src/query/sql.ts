import { SENSITIVITY_ORDER, isSensitivity } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { isRfc3339 } from "../util/time";

/**
 * `julianday(...)` over an RFC3339 column normalized the way the frozen event
 * contract allows: lowercase `t`/`z` upper-cased, a leap second `:60` mapped
 * to `:59.999` of its own minute. `column` MUST be a column reference; it is
 * substituted several times, so a `?` placeholder is not allowed here.
 *
 * `agents/time.ts` maps a leap second to the next second for grant windows.
 * This helper maps it to the last representable instant of the stated minute
 * so window membership stays inside the stated second.
 */
export function instantSql(column: string): string {
  return `julianday(
  replace(
    replace(
      CASE
        WHEN substr(${column}, 18, 2) = '60' THEN
          substr(${column}, 1, 17) || '59.999' ||
          CASE
            WHEN lower(substr(${column}, -1)) = 'z' THEN 'Z'
            ELSE substr(${column}, -6)
          END
        ELSE ${column}
      END,
      't', 'T'
    ),
    'z', 'Z'
  )
)`;
}

function normalizeInstant(value: string): string {
  const leap =
    value.slice(17, 19) === "60"
      ? `${value.slice(0, 17)}59.999${value.slice(19)}`
      : value;
  return leap.replace("t", "T").replace(/z$/i, "Z");
}

export function instantBound(value: string, label: string): string {
  if (!isRfc3339(value)) {
    throw new RangeError(`${label} must be an RFC3339 timestamp`);
  }
  return new Date(normalizeInstant(value)).toISOString();
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
