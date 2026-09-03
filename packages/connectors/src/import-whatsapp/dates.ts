import { KizukiError } from "../errors";

/**
 * A chat export carries the exporting device's local time in the device's
 * locale, with no zone and no format declaration. Everything here turns that
 * into an instant, or refuses to guess.
 */

export type DateOrder = "dmy" | "mdy" | "ymd";

const DATE_ORDERS: readonly DateOrder[] = ["dmy", "mdy", "ymd"];

export function isDateOrder(value: unknown): value is DateOrder {
  return (
    typeof value === "string" &&
    (DATE_ORDERS as readonly string[]).includes(value)
  );
}

/** The three date fields as written, left to right. */
export interface RawDate {
  a: number;
  b: number;
  c: number;
  wide_first: boolean;
}

export interface RawTime {
  hour: number;
  minute: number;
  second: number | null;
  meridiem: "am" | "pm" | null;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function expandYear(value: number): number {
  return value < 100 ? 2000 + value : value;
}

function partsOf(date: RawDate, order: DateOrder): DateParts {
  if (order === "ymd") {
    return { year: date.a, month: date.b, day: date.c };
  }
  if (order === "dmy") {
    return { year: expandYear(date.c), month: date.b, day: date.a };
  }
  return { year: expandYear(date.c), month: date.a, day: date.b };
}

/**
 * A real calendar check by round trip, so month 13, day 32 and February 30 all
 * fail rather than rolling silently into the next month.
 */
function isRealDate(parts: DateParts): boolean {
  if (parts.year < 1000 || parts.month < 1 || parts.day < 1) return false;
  const instant = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return (
    instant.getUTCFullYear() === parts.year &&
    instant.getUTCMonth() === parts.month - 1 &&
    instant.getUTCDate() === parts.day
  );
}

function ordinal(date: RawDate, order: DateOrder): number {
  const parts = partsOf(date, order);
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function isChronological(dates: readonly RawDate[], order: DateOrder): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const date of dates) {
    const current = ordinal(date, order);
    if (current < previous) return false;
    previous = current;
  }
  return true;
}

/**
 * Evidence first, chronology second, refusal last. A chat is exported in
 * order, so the hypothesis under which the file runs backwards is wrong; when
 * both survive, the owner is asked instead of guessed at.
 */
export function detectDateOrder(dates: readonly RawDate[]): DateOrder {
  const wide = dates.filter((date) => date.wide_first).length;
  if (wide > 0) {
    if (wide !== dates.length) {
      throw new KizukiError("parse_error", "inconsistent date formats");
    }
    return "ymd";
  }
  const dayFirst = dates.some((date) => date.a > 12);
  const monthFirst = dates.some((date) => date.b > 12);
  if (dayFirst && monthFirst) {
    throw new KizukiError("parse_error", "inconsistent dates");
  }
  if (dayFirst) return "dmy";
  if (monthFirst) return "mdy";

  const dmy = isChronological(dates, "dmy");
  const mdy = isChronological(dates, "mdy");
  if (dmy && !mdy) return "dmy";
  if (mdy && !dmy) return "mdy";
  throw new KizukiError(
    "parse_error",
    'ambiguous date order (DD/MM vs MM/DD); set date_order to "dmy" or "mdy"',
  );
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function resolveHour(time: RawTime, line: number): number {
  if (time.meridiem === null) {
    if (time.hour > 23) {
      throw new KizukiError("parse_error", `line ${line}: hour out of range`);
    }
    return time.hour;
  }
  if (time.hour < 1 || time.hour > 12) {
    throw new KizukiError(
      "parse_error",
      `line ${line}: hour out of range for a twelve-hour clock`,
    );
  }
  if (time.meridiem === "am") return time.hour === 12 ? 0 : time.hour;
  return time.hour === 12 ? 12 : time.hour + 12;
}

/** The stamp exactly as written, once the order and the clock are resolved. */
export function localTimestamp(
  date: RawDate,
  time: RawTime,
  order: DateOrder,
  line: number,
): string {
  const parts = partsOf(date, order);
  if (!isRealDate(parts)) {
    throw new KizukiError(
      "parse_error",
      `line ${line}: not a real calendar date`,
    );
  }
  const hour = resolveHour(time, line);
  if (time.minute > 59 || (time.second !== null && time.second > 59)) {
    throw new KizukiError("parse_error", `line ${line}: time out of range`);
  }
  const day = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  const clock = `${pad(hour)}:${pad(time.minute)}`;
  return time.second === null
    ? `${day}T${clock}`
    : `${day}T${clock}:${pad(time.second)}`;
}

const FIXED_OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/**
 * Keyed by zones that already constructed, so the map cannot grow past the
 * zones a host accepts. Building the formatter costs more than every
 * conversion that uses it, and an export converts once per message.
 */
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = ZONE_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch (error) {
    throw new KizukiError("misconfigured", `unknown time zone: ${timeZone}`, {
      cause: error,
    });
  }
  ZONE_FORMATTERS.set(timeZone, format);
  return format;
}

export function resolveTimezone(value: string | undefined): string {
  if (value === undefined) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  const fixed = FIXED_OFFSET.exec(value);
  if (fixed !== null) {
    const hours = Number(fixed[2]);
    const minutes = Number(fixed[3]);
    if (hours > 14 || minutes > 59) {
      throw new KizukiError(
        "misconfigured",
        `time zone offset out of range: ${value}`,
      );
    }
    return value;
  }
  zoneFormatter(value);
  return value;
}

const LOCAL_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const DAY_MS = 86_400_000;

/** The wall clock a zone shows at an instant, expressed as a UTC epoch. */
function wallClockMs(format: Intl.DateTimeFormat, instant: number): number {
  const parts = new Map(
    format
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value] as const),
  );
  return Date.UTC(
    Number(parts.get("year")),
    Number(parts.get("month")) - 1,
    Number(parts.get("day")),
    Number(parts.get("hour")),
    Number(parts.get("minute")),
    Number(parts.get("second")),
  );
}

function offsetMs(format: Intl.DateTimeFormat, instant: number): number {
  return wallClockMs(format, instant) - instant;
}

export function localToUtc(local_timestamp: string, timezone: string): string {
  const matched = LOCAL_TIMESTAMP.exec(local_timestamp);
  if (matched === null) {
    throw new KizukiError(
      "parse_error",
      `not a local timestamp: ${local_timestamp}`,
    );
  }
  const wall = Date.UTC(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
    matched[6] === undefined ? 0 : Number(matched[6]),
  );

  const fixed = FIXED_OFFSET.exec(timezone);
  if (fixed !== null) {
    const sign = fixed[1] === "-" ? -1 : 1;
    const offset = sign * (Number(fixed[2]) * 60 + Number(fixed[3])) * 60_000;
    return new Date(wall - offset).toISOString();
  }

  // The offsets a day either side bracket any single transition, so both
  // candidate instants for a wall clock inside the transition are available.
  const format = zoneFormatter(timezone);
  const before = offsetMs(format, wall - DAY_MS);
  const after = offsetMs(format, wall + DAY_MS);
  const candidates =
    before === after ? [wall - before] : [wall - before, wall - after];
  const valid = candidates
    .filter((instant) => wallClockMs(format, instant) === wall)
    .sort((left, right) => left - right);
  const earliest = valid[0];
  // A repeated wall clock keeps the earlier instant; one that never happened
  // moves forward by the size of the gap.
  if (earliest !== undefined) return new Date(earliest).toISOString();
  return new Date(wall + (after - before) - after).toISOString();
}
