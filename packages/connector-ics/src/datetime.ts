import { KizukiError } from "@kizuki/core";
import type { ZoneInfo } from "./parse";

export type IcsInstant =
  | { kind: "utc"; iso: string }
  | { kind: "date"; date: string }
  | { kind: "floating"; local: string }
  | { kind: "zoned"; local: string; tzid: string };

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type TzApproximation =
  "none" | "floating" | "vtimezone-fixed-offset" | "unresolved";

export interface ZoneResolver {
  offsetMinutes(tzid: string, utcGuessMs: number): number | null;
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;
const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;

function malformed(): never {
  throw new KizukiError("parse_error", "kizuki.ics: malformed date-time value");
}

export function parseLocal(compact: string): LocalDateTime {
  const withTime = DATE_TIME.exec(compact);
  if (withTime !== null) {
    return {
      year: Number(withTime[1]),
      month: Number(withTime[2]),
      day: Number(withTime[3]),
      hour: Number(withTime[4]),
      minute: Number(withTime[5]),
      second: Number(withTime[6]),
    };
  }
  const dateOnly = DATE_ONLY.exec(compact);
  if (dateOnly === null) malformed();
  return {
    year: Number(dateOnly[1]),
    month: Number(dateOnly[2]),
    day: Number(dateOnly[3]),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

const pad = (value: number, width = 2): string =>
  String(value).padStart(width, "0");

export function formatLocal(local: LocalDateTime): string {
  return `${pad(local.year, 4)}${pad(local.month)}${pad(local.day)}T${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`;
}

export function formatLocalDate(local: LocalDateTime): string {
  return `${pad(local.year, 4)}${pad(local.month)}${pad(local.day)}`;
}

/** Civil time read as if it were UTC; the zone shift is applied separately. */
export function localToMs(local: LocalDateTime): number {
  return Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
}

export function msToLocal(ms: number): LocalDateTime {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

export function parseDateTime(
  value: string,
  params: Record<string, string>,
): IcsInstant {
  const compact = value.trim();
  const isDateValue =
    (params["VALUE"] ?? "").toUpperCase() === "DATE" || DATE_ONLY.test(compact);
  if (isDateValue) {
    const local = parseLocal(compact);
    if (!DATE_ONLY.test(compact)) malformed();
    return { kind: "date", date: formatLocalDate(local) };
  }
  const match = DATE_TIME.exec(compact);
  if (match === null) malformed();
  const local = parseLocal(compact);
  if (match[7] === "Z") {
    return { kind: "utc", iso: new Date(localToMs(local)).toISOString() };
  }
  const tzid = (params["TZID"] ?? "").trim();
  if (tzid.length > 0) {
    return { kind: "zoned", local: formatLocal(local), tzid };
  }
  return { kind: "floating", local: formatLocal(local) };
}

const OFFSET = /GMT(?:([+-])(\d{2}):(\d{2}))?/;

/** Asks the platform's IANA database; an unknown id yields null, never a guess. */
export const intlZones: ZoneResolver = {
  offsetMinutes(tzid, utcGuessMs) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tzid,
        timeZoneName: "longOffset",
      });
      const rendered = formatter.format(new Date(utcGuessMs));
      const match = OFFSET.exec(rendered);
      if (match === null) return null;
      if (match[1] === undefined) return 0;
      const sign = match[1] === "-" ? -1 : 1;
      return sign * (Number(match[2]) * 60 + Number(match[3]));
    } catch {
      return null;
    }
  },
};

export function vtimezoneFixedOffset(
  zone: ZoneInfo | undefined,
): number | null {
  if (zone === undefined) return null;
  return zone.standardOffsetMinutes;
}

export function toUtc(
  instant: IcsInstant,
  zones: ZoneResolver,
  file: Map<string, ZoneInfo>,
): { iso: string; approximation: TzApproximation } {
  if (instant.kind === "utc")
    return { iso: instant.iso, approximation: "none" };
  if (instant.kind === "date") {
    const date = instant.date;
    return {
      iso: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00.000Z`,
      approximation: "none",
    };
  }
  const local = parseLocal(instant.local);
  const guess = localToMs(local);
  if (instant.kind === "floating") {
    return { iso: new Date(guess).toISOString(), approximation: "floating" };
  }

  const first = zones.offsetMinutes(instant.tzid, guess);
  if (first !== null) {
    // Second pass so a start near a DST transition keeps its civil time.
    const provisional = guess - first * 60_000;
    const second = zones.offsetMinutes(instant.tzid, provisional) ?? first;
    return {
      iso: new Date(guess - second * 60_000).toISOString(),
      approximation: "none",
    };
  }
  const fixed = vtimezoneFixedOffset(file.get(instant.tzid));
  if (fixed !== null) {
    return {
      iso: new Date(guess - fixed * 60_000).toISOString(),
      approximation: "vtimezone-fixed-offset",
    };
  }
  return { iso: new Date(guess).toISOString(), approximation: "unresolved" };
}
