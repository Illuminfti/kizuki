import type { IcsInstant, LocalDateTime } from "./datetime";
import { daysInMonth, formatLocal, localToMs, msToLocal, parseLocal } from "./datetime";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ByDay {
  /** `null` for a plain weekday; `2` for `2MO`, `-1` for `-1FR`. */
  ordinal: number | null;
  weekday: Weekday;
}

export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: IcsInstant;
  byday?: ByDay[];
  bymonthday?: number[];
  bymonth?: number[];
  wkst: Weekday;
}

export interface ExpandOptions {
  windowEnd: LocalDateTime;
  maxInstances: number;
  exdates: Set<string>;
  rdates: LocalDateTime[];
  maxSteps: number;
}

export interface ExpandResult {
  instances: LocalDateTime[];
  truncated: boolean;
  /** Candidate iterations spent, so a caller can budget across a whole file. */
  steps: number;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const SUPPORTED = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "WKST",
]);

function weekdayOf(token: string): Weekday | null {
  const index = WEEKDAYS.indexOf(
    token.toUpperCase() as (typeof WEEKDAYS)[number],
  );
  return index === -1 ? null : (index as Weekday);
}

/**
 * Parses the explicit subset. Anything outside it returns `{ unsupported }`
 * so the caller emits the master once rather than inventing a wrong series.
 */
export function parseRrule(
  value: string,
): { rule: RecurrenceRule } | { unsupported: string } {
  const parts = new Map<string, string>();
  for (const piece of value.split(";")) {
    const separator = piece.indexOf("=");
    if (separator === -1) continue;
    parts.set(
      piece.slice(0, separator).trim().toUpperCase(),
      piece.slice(separator + 1).trim(),
    );
  }
  for (const key of parts.keys()) {
    if (!SUPPORTED.has(key)) return { unsupported: key };
  }

  const freq = (parts.get("FREQ") ?? "").toUpperCase();
  if (
    freq !== "DAILY" &&
    freq !== "WEEKLY" &&
    freq !== "MONTHLY" &&
    freq !== "YEARLY"
  ) {
    return { unsupported: `FREQ=${freq}` };
  }

  const rule: RecurrenceRule = { freq, interval: 1, wkst: 1 };
  const interval = parts.get("INTERVAL");
  if (interval !== undefined) {
    const parsed = Number(interval);
    if (!Number.isInteger(parsed) || parsed < 1)
      return { unsupported: "INTERVAL" };
    rule.interval = parsed;
  }
  const count = parts.get("COUNT");
  if (count !== undefined) {
    const parsed = Number(count);
    if (!Number.isInteger(parsed) || parsed < 1)
      return { unsupported: "COUNT" };
    rule.count = parsed;
  }
  const until = parts.get("UNTIL");
  if (until !== undefined) {
    if (/^\d{8}T\d{6}Z$/.test(until)) {
      rule.until = {
        kind: "utc",
        iso: new Date(localToMs(parseLocal(until.slice(0, 15)))).toISOString(),
      };
    } else if (/^\d{8}$/.test(until)) {
      rule.until = { kind: "date", date: until };
    } else {
      return { unsupported: "UNTIL" };
    }
  }
  const byday = parts.get("BYDAY");
  if (byday !== undefined) {
    const entries: ByDay[] = [];
    for (const token of byday.split(",")) {
      const match = /^([+-]?\d+)?([A-Za-z]{2})$/.exec(token.trim());
      if (match === null) return { unsupported: "BYDAY" };
      const weekday = weekdayOf(match[2] ?? "");
      if (weekday === null) return { unsupported: "BYDAY" };
      entries.push({
        ordinal: match[1] === undefined ? null : Number(match[1]),
        weekday,
      });
    }
    rule.byday = entries;
  }
  const bymonthday = parts.get("BYMONTHDAY");
  if (bymonthday !== undefined) {
    const days = bymonthday.split(",").map((piece) => Number(piece.trim()));
    if (
      days.some(
        (day) => !Number.isInteger(day) || day === 0 || Math.abs(day) > 31,
      )
    ) {
      return { unsupported: "BYMONTHDAY" };
    }
    rule.bymonthday = days;
  }
  const bymonth = parts.get("BYMONTH");
  if (bymonth !== undefined) {
    const months = bymonth.split(",").map((piece) => Number(piece.trim()));
    if (
      months.some(
        (month) => !Number.isInteger(month) || month < 1 || month > 12,
      )
    ) {
      return { unsupported: "BYMONTH" };
    }
    rule.bymonth = months;
  }
  const wkst = parts.get("WKST");
  if (wkst !== undefined) {
    const weekday = weekdayOf(wkst);
    if (weekday === null) return { unsupported: "WKST" };
    rule.wkst = weekday;
  }
  const ignored = ignoredForFrequency(rule);
  if (ignored !== null) return { unsupported: ignored };
  return { rule };
}

/**
 * RFC 5545 gives each BY* part a meaning only for some frequencies, and the
 * expansion below implements exactly the combinations the connector claims.
 * A part this frequency does not use has to be reported: expanding as though
 * it were absent turns "every weekday" into "every day".
 */
function ignoredForFrequency(rule: RecurrenceRule): string | null {
  if (rule.freq === "DAILY") {
    if (rule.byday !== undefined) return "BYDAY";
    if (rule.bymonthday !== undefined) return "BYMONTHDAY";
    if (rule.bymonth !== undefined) return "BYMONTH";
    return null;
  }
  if (rule.freq === "WEEKLY") {
    if (rule.byday?.some((entry) => entry.ordinal !== null) === true) {
      return "BYDAY";
    }
    if (rule.bymonthday !== undefined) return "BYMONTHDAY";
    if (rule.bymonth !== undefined) return "BYMONTH";
    return null;
  }
  if (rule.freq === "MONTHLY" && rule.bymonth !== undefined) return "BYMONTH";
  return null;
}

const DAY_MS = 86_400_000;

function weekdayAt(local: LocalDateTime): Weekday {
  return new Date(localToMs(local)).getUTCDay() as Weekday;
}

function withDay(
  base: LocalDateTime,
  year: number,
  month: number,
  day: number,
): LocalDateTime {
  return { ...base, year, month, day };
}

function monthCandidates(
  rule: RecurrenceRule,
  base: LocalDateTime,
  year: number,
  month: number,
): LocalDateTime[] {
  const total = daysInMonth(year, month);
  let byMonthDay: Set<number> | null = null;
  if (rule.bymonthday !== undefined) {
    byMonthDay = new Set<number>();
    for (const day of rule.bymonthday) {
      const resolved = day > 0 ? day : total + day + 1;
      if (resolved >= 1 && resolved <= total) byMonthDay.add(resolved);
    }
  }
  let byDay: Set<number> | null = null;
  if (rule.byday !== undefined) {
    byDay = new Set<number>();
    for (const entry of rule.byday) {
      const matching: number[] = [];
      for (let day = 1; day <= total; day += 1) {
        if (weekdayAt(withDay(base, year, month, day)) === entry.weekday) {
          matching.push(day);
        }
      }
      if (entry.ordinal === null) {
        for (const day of matching) byDay.add(day);
        continue;
      }
      const index =
        entry.ordinal > 0 ? entry.ordinal - 1 : matching.length + entry.ordinal;
      const day = matching[index];
      if (day !== undefined) byDay.add(day);
    }
  }
  // RFC 5545 §3.3.10: BYDAY expands on its own but narrows an explicit
  // BYMONTHDAY, which is what makes "every Friday the 13th" one day a month.
  const days = new Set<number>();
  if (byMonthDay !== null && byDay !== null) {
    for (const day of byMonthDay) if (byDay.has(day)) days.add(day);
  } else if (byMonthDay !== null) {
    for (const day of byMonthDay) days.add(day);
  } else if (byDay !== null) {
    for (const day of byDay) days.add(day);
  } else if (base.day <= total) {
    // An instance whose civil date does not exist is skipped, never clamped
    // onto a neighbouring day; with a BY* rule the empty set is the answer.
    days.add(base.day);
  }
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => withDay(base, year, month, day));
}

/**
 * Without BYMONTH a yearly BY* rule is scoped to the whole year, not to
 * DTSTART's month: `BYDAY=20MO` is the twentieth Monday of the year.
 */
function yearCandidates(
  rule: RecurrenceRule,
  base: LocalDateTime,
  year: number,
): LocalDateTime[] {
  const everyDay: LocalDateTime[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const total = daysInMonth(year, month);
    for (let day = 1; day <= total; day += 1) {
      everyDay.push(withDay(base, year, month, day));
    }
  }

  let byDay: Set<string> | null = null;
  if (rule.byday !== undefined) {
    byDay = new Set<string>();
    for (const entry of rule.byday) {
      const matching = everyDay.filter((day) => weekdayAt(day) === entry.weekday);
      if (entry.ordinal === null) {
        for (const day of matching) byDay.add(formatLocal(day));
        continue;
      }
      const index =
        entry.ordinal > 0 ? entry.ordinal - 1 : matching.length + entry.ordinal;
      const day = matching[index];
      if (day !== undefined) byDay.add(formatLocal(day));
    }
  }

  let byMonthDay: Set<string> | null = null;
  if (rule.bymonthday !== undefined) {
    byMonthDay = new Set<string>();
    for (let month = 1; month <= 12; month += 1) {
      const total = daysInMonth(year, month);
      for (const day of rule.bymonthday) {
        const resolved = day > 0 ? day : total + day + 1;
        if (resolved >= 1 && resolved <= total) {
          byMonthDay.add(formatLocal(withDay(base, year, month, resolved)));
        }
      }
    }
  }

  // BYDAY expands on its own but narrows an explicit BYMONTHDAY, the same
  // rule that makes "every Friday the 13th" one day a month.
  return everyDay.filter((day) => {
    const key = formatLocal(day);
    if (byDay !== null && byMonthDay !== null) {
      return byDay.has(key) && byMonthDay.has(key);
    }
    if (byDay !== null) return byDay.has(key);
    return byMonthDay !== null && byMonthDay.has(key);
  });
}

function untilMs(rule: RecurrenceRule): number | null {
  if (rule.until === undefined) return null;
  if (rule.until.kind === "utc") return Date.parse(rule.until.iso);
  if (rule.until.kind === "date") {
    return localToMs(parseLocal(rule.until.date)) + DAY_MS - 1;
  }
  return null;
}

/**
 * Expansion runs in local civil time; the caller converts each instance with
 * the DTSTART zone. Every loop is bounded, so a pathological rule costs a
 * fixed number of steps rather than the process.
 */
export function expand(
  rule: RecurrenceRule,
  dtstart: LocalDateTime,
  opts: ExpandOptions,
): ExpandResult {
  const limitMs = localToMs(opts.windowEnd);
  const ruleUntil = untilMs(rule);
  const collected: LocalDateTime[] = [];
  let emitted = 0;
  let steps = 0;
  let truncated = false;

  const accept = (candidate: LocalDateTime): boolean => {
    const ms = localToMs(candidate);
    if (ms < localToMs(dtstart)) return true;
    if (ruleUntil !== null && ms > ruleUntil) return false;
    if (ms > limitMs) return false;
    emitted += 1;
    if (!opts.exdates.has(formatLocal(candidate))) collected.push(candidate);
    return !(rule.count !== undefined && emitted >= rule.count);
  };

  let cursor = { ...dtstart };
  outer: for (;;) {
    steps += 1;
    if (steps > opts.maxSteps) {
      truncated = true;
      break;
    }
    let candidates: LocalDateTime[];
    if (rule.freq === "DAILY") {
      candidates = [cursor];
    } else if (rule.freq === "WEEKLY") {
      const weekdays =
        rule.byday !== undefined
          ? rule.byday.map((entry) => entry.weekday)
          : [weekdayAt(dtstart)];
      const startOfWeek =
        localToMs(cursor) - ((weekdayAt(cursor) - rule.wkst + 7) % 7) * DAY_MS;
      candidates = weekdays
        .map(
          (weekday) => startOfWeek + ((weekday - rule.wkst + 7) % 7) * DAY_MS,
        )
        .sort((a, b) => a - b)
        .map((ms) => ({
          ...msToLocal(ms),
          hour: dtstart.hour,
          minute: dtstart.minute,
          second: dtstart.second,
        }));
    } else if (rule.freq === "MONTHLY") {
      candidates = monthCandidates(rule, dtstart, cursor.year, cursor.month);
    } else if (rule.bymonth !== undefined) {
      candidates = [...rule.bymonth]
        .sort((a, b) => a - b)
        .flatMap((month) =>
          rule.byday !== undefined || rule.bymonthday !== undefined
            ? monthCandidates(rule, dtstart, cursor.year, month)
            : dtstart.day <= daysInMonth(cursor.year, month)
              ? [withDay(dtstart, cursor.year, month, dtstart.day)]
              : [],
        );
    } else if (rule.byday !== undefined || rule.bymonthday !== undefined) {
      candidates = yearCandidates(rule, dtstart, cursor.year);
    } else {
      candidates =
        dtstart.day <= daysInMonth(cursor.year, dtstart.month)
          ? [withDay(dtstart, cursor.year, dtstart.month, dtstart.day)]
          : [];
    }

    for (const candidate of candidates) {
      if (!accept(candidate)) break outer;
    }
    if (localToMs(cursor) > limitMs) break;

    if (rule.freq === "DAILY") {
      cursor = msToLocal(localToMs(cursor) + rule.interval * DAY_MS);
    } else if (rule.freq === "WEEKLY") {
      cursor = msToLocal(localToMs(cursor) + rule.interval * 7 * DAY_MS);
    } else if (rule.freq === "MONTHLY") {
      const advanced = cursor.month - 1 + rule.interval;
      cursor = {
        ...cursor,
        year: cursor.year + Math.floor(advanced / 12),
        month: (advanced % 12) + 1,
        day: 1,
      };
    } else {
      cursor = { ...cursor, year: cursor.year + rule.interval };
    }
    if (localToMs(cursor) > limitMs && collected.length > 0) break;
  }

  for (const rdate of opts.rdates) {
    const key = formatLocal(rdate);
    if (opts.exdates.has(key)) continue;
    if (collected.some((entry) => formatLocal(entry) === key)) continue;
    collected.push(rdate);
  }
  collected.sort((a, b) => localToMs(a) - localToMs(b));

  if (collected.length > opts.maxInstances) {
    // Keep the most recent window: a long-running series is more useful at
    // its tail than at its beginning.
    return {
      instances: collected.slice(-opts.maxInstances),
      truncated: true,
      steps,
    };
  }
  return { instances: collected, truncated, steps };
}
