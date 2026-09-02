/**
 * SQL fragments and caller-bound validation shared by the derived query
 * layers. Search, timeline and graph must spell an instant, the sensitivity
 * lattice and a bound check exactly once, or two of them will drift.
 */
import { SENSITIVITY_ORDER } from "../agents/types";
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

const LEAP_FRACTION = /^\.\d+/;

function normalizeInstant(value: string): string {
  if (value.slice(17, 19) !== "60") {
    return value.replace("t", "T").replace(/z$/i, "Z");
  }
  // The rewritten `59.999` replaces the whole seconds component, fraction
  // included: `instantSql`'s CASE branch drops the original fraction too, so
  // keeping it here would build `23:59:59.999.500Z` and disagree with the
  // column on a timestamp the frozen contract accepts.
  const rest = value.slice(19);
  const fraction = LEAP_FRACTION.exec(rest)?.[0] ?? "";
  const leap = `${value.slice(0, 17)}59.999${rest.slice(fraction.length)}`;
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

/** `?, ?, …` for an `IN` list of `count` bindings. */
export function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}

/** `label` names the caller's option so the message points at the argument. */
export function validLimit(limit: number, label: string): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`${label} limit must be a non-negative integer`);
  }
  return limit;
}
