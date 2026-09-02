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
 * contract allows: lowercase `t` upper-cased, a leap second `:60` mapped to
 * `:59.999` of its own minute, and the UTC offset applied here rather than by
 * SQLite. `column` MUST be a column reference; it is substituted several
 * times, so a `?` placeholder is not allowed here — bind through
 * `instantParam` instead.
 *
 * SQLite's date parser rejects any offset past ±14:59, while `isRfc3339` — and
 * therefore the event contract, and therefore the ledger, which stores
 * `occurred_at` verbatim — accepts up to ±23:59. Handing it the whole string
 * evaluates those timestamps to NULL, which drops the event from every window
 * and sorts it first. Splitting the offset off and subtracting it as minutes
 * keeps the expression total over every form the contract admits.
 *
 * `agents/time.ts` maps a leap second to the next second for grant windows.
 * This helper maps it to the last representable instant of the stated minute
 * so window membership stays inside the stated second.
 */
export function instantSql(column: string): string {
  // A numeric offset is always the trailing `±HH:MM`, and the shortest
  // contract-valid timestamp is 20 characters, so the sixth character from the
  // end of a `Z`-terminated one is always a digit or a dot.
  const zoned = `substr(${column}, -6, 1) IN ('+', '-')`;
  const civil = `CASE
      WHEN substr(${column}, 18, 2) = '60'
        THEN substr(${column}, 1, 17) || '59.999'
      WHEN ${zoned} THEN substr(${column}, 1, length(${column}) - 6)
      ELSE substr(${column}, 1, length(${column}) - 1)
    END`;
  const offsetMinutes = `CASE
      WHEN ${zoned} THEN
        (CASE substr(${column}, -6, 1) WHEN '-' THEN -1 ELSE 1 END) *
        (CAST(substr(${column}, -5, 2) AS INTEGER) * 60 +
         CAST(substr(${column}, -2, 2) AS INTEGER))
      ELSE 0
    END`;
  return `(julianday(replace(${civil}, 't', 'T')) - (${offsetMinutes}) / 1440.0)`;
}

/**
 * `instantSql` over one bound parameter: the value is named once in a
 * single-row subquery, so a caller binds it once however many times the
 * expression reads it. Bound and column then run byte-identical SQL, which is
 * what makes them agree on a fraction finer than the millisecond a `Date`
 * round-trip can carry, and on an offset SQLite refuses to parse.
 */
export const instantParam = `(SELECT ${instantSql("bound.v")} FROM (SELECT ? AS v) AS bound)`;

/**
 * Validates a caller-supplied bound with `isRfc3339` (RangeError
 * `${label} must be an RFC3339 timestamp` otherwise) and returns the text to
 * bind to `instantParam`. The value is returned unchanged on purpose: the
 * bound is normalized by the same expression as the column it is compared
 * against, so no conversion here can disagree with SQLite's own parse.
 */
export function instantBound(value: string, label: string): string {
  if (!isRfc3339(value)) {
    throw new RangeError(`${label} must be an RFC3339 timestamp`);
  }
  return value;
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
