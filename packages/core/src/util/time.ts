/**
 * RFC3339 timestamp validation.
 *
 * `Date.parse` is not usable here: it accepts a superset of RFC3339 (bare
 * dates, month 13 rolled into the next year, "2026-02-30", offsets like
 * "+99:00"), so every field is range-checked against a real calendar instead.
 *
 * Fractional seconds are capped at nine digits (nanoseconds). Extra digits are
 * refused rather than rounded, so the accepted instant is unchanged.
 */

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** Nanosecond precision. Hostile extra digits are not a different instant. */
export const RFC3339_MAX_FRACTION_DIGITS = 9;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isRfc3339(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = RFC3339.exec(s);
  if (m === null) return false;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);

  if (year < 1) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  // RFC3339 §5.6 leap seconds are second 60 of minute 59 only.
  if (second > 60 || (second === 60 && minute !== 59)) return false;
  if ((m[7] ?? "").length > RFC3339_MAX_FRACTION_DIGITS) return false;

  const sign = m[9];
  if (sign !== undefined) {
    const offsetHour = Number(m[10]);
    const offsetMinute = Number(m[11]);
    if (offsetHour > 23) return false;
    if (offsetMinute > 59) return false;
    // "-00:00" means "offset unknown" in RFC3339 and is legal.
  }

  return true;
}


/** Canonical UTC spelling for lexical-safe storage and compare.
 * Offset-equivalent RFC3339 inputs map to one `...Z` form with nine nanos.
 * Leap second `:60` maps to nanosecond 999999999 of minute 59 (same as SQL).
 * Returns null when `isRfc3339` would reject.
 */
export function canonicalizeRfc3339Utc(s: string): string | null {
  if (!isRfc3339(s)) return null;
  const m = RFC3339.exec(s);
  if (m === null) return null;

  const second = Number(m[6]);
  const date = new Date(0);
  date.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  date.setUTCHours(Number(m[4]), Number(m[5]), Math.min(second, 59), 0);
  let epochSecond = Math.trunc(date.getTime() / 1_000);

  const offsetSeconds = Number(m[10] ?? 0) * 3_600 + Number(m[11] ?? 0) * 60;
  if (m[9] === "+") epochSecond -= offsetSeconds;
  if (m[9] === "-") epochSecond += offsetSeconds;

  const nanos =
    second === 60
      ? 999_999_999
      : Number(((m[7] ?? "") + "000000000").slice(0, 9));
  if (!Number.isFinite(nanos)) return null;

  const utc = new Date(epochSecond * 1_000);
  const yyyy = String(utc.getUTCFullYear()).padStart(4, "0");
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  const hh = String(utc.getUTCHours()).padStart(2, "0");
  const mi = String(utc.getUTCMinutes()).padStart(2, "0");
  const ss = String(utc.getUTCSeconds()).padStart(2, "0");
  const frac = String(Math.trunc(nanos)).padStart(9, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${frac}Z`;
}
