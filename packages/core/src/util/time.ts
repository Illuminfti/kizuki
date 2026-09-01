/**
 * RFC3339 timestamp validation.
 *
 * `Date.parse` is not usable here: it accepts a superset of RFC3339 (bare
 * dates, month 13 rolled into the next year, "2026-02-30", offsets like
 * "+99:00"), so every field is range-checked against a real calendar instead.
 */

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

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
  // 60 is the leap second, permitted by RFC3339 section 5.6.
  if (second > 60) return false;

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
