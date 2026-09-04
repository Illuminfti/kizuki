import { isRfc3339 } from "@kizuki/core";
import { ScreenpipeConnectorError } from "./errors";

const LEGACY_SQLX =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const LOCAL_WALL =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const FIXED_OFFSET = /^([+-])(\d{2}):(\d{2})$/;
const DAY_MS = 86_400_000;
export const MAX_AUDIO_OFFSET_SECONDS = 86_400;

export type TimestampParse =
  | { kind: "instant"; iso: string }
  | { kind: "offset_unknown"; local: string }
  | { kind: "unparseable" };

export type TimestampResolve =
  | { iso: string }
  | { reject: "unparseable" | "offset_unknown" };

const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export function parseTimestamp(raw: unknown): TimestampParse {
  if (typeof raw !== "string") return { kind: "unparseable" };

  if (isRfc3339(raw)) {
    if (raw.endsWith("-00:00")) {
      return { kind: "offset_unknown", local: raw.slice(0, -6) };
    }
    try {
      return { kind: "instant", iso: new Date(raw).toISOString() };
    } catch {
      return { kind: "unparseable" };
    }
  }

  const match = LEGACY_SQLX.exec(raw);
  if (match === null) return { kind: "unparseable" };
  const date = match[1];
  const hoursAndMinutes = match[2];
  if (date === undefined || hoursAndMinutes === undefined) {
    return { kind: "unparseable" };
  }
  const local = `${date}T${hoursAndMinutes}${match[3] ?? ":00"}`;
  if (!isRfc3339(`${local}Z`)) return { kind: "unparseable" };
  const offset = match[4];
  if (offset === undefined || offset === "-00:00") {
    return { kind: "offset_unknown", local };
  }
  const rfc = `${local}${offset}`;
  if (!isRfc3339(rfc)) return { kind: "unparseable" };
  try {
    return { kind: "instant", iso: new Date(rfc).toISOString() };
  } catch {
    return { kind: "unparseable" };
  }
}

export function resolveTimestamp(
  raw: unknown,
  timeZone: string | null,
): TimestampResolve {
  const parsed = parseTimestamp(raw);
  switch (parsed.kind) {
    case "instant":
      return { iso: parsed.iso };
    case "unparseable":
      return { reject: "unparseable" };
    case "offset_unknown": {
      if (timeZone === null) return { reject: "offset_unknown" };
      const iso = localToUtc(parsed.local, timeZone);
      return iso === null ? { reject: "unparseable" } : { iso };
    }
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}

export function normalizeTimestamp(
  raw: unknown,
  timeZone: string | null = null,
): string | null {
  const resolved = resolveTimestamp(raw, timeZone);
  return "iso" in resolved ? resolved.iso : null;
}

export function offsetSeconds(base: string, seconds: unknown): string | null {
  if (seconds === null || seconds === undefined) return base;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  if (seconds < 0 || seconds >= MAX_AUDIO_OFFSET_SECONDS) return null;
  const start = Date.parse(base);
  if (!Number.isFinite(start)) return null;
  const shifted = start + seconds * 1_000;
  if (!Number.isFinite(shifted)) return null;
  return new Date(shifted).toISOString();
}

export function parseTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ScreenpipeConnectorError(
      "misconfigured",
      "kizuki.screenpipe: config.timezone must be an IANA name or ±HH:MM offset",
    );
  }
  if (value === "Z") return "Z";
  const fixed = FIXED_OFFSET.exec(value);
  if (fixed !== null) {
    const hours = Number(fixed[2]);
    const minutes = Number(fixed[3]);
    if (hours > 14 || minutes > 59) {
      throw new ScreenpipeConnectorError(
        "misconfigured",
        "kizuki.screenpipe: config.timezone offset is out of range",
      );
    }
    return value;
  }
  zoneFormatter(value);
  return value;
}

export function localToUtc(local: string, timeZone: string): string | null {
  const matched = LOCAL_WALL.exec(stripFraction(local));
  if (matched === null) return null;
  const wall = Date.UTC(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
    Number(matched[6]),
  );
  if (timeZone === "Z") return new Date(wall).toISOString();

  const fixed = FIXED_OFFSET.exec(timeZone);
  if (fixed !== null) {
    const sign = fixed[1] === "-" ? -1 : 1;
    const offset = sign * (Number(fixed[2]) * 60 + Number(fixed[3])) * 60_000;
    return new Date(wall - offset).toISOString();
  }

  try {
    const format = zoneFormatter(timeZone);
    const before = offsetMs(format, wall - DAY_MS);
    const after = offsetMs(format, wall + DAY_MS);
    const candidates =
      before === after ? [wall - before] : [wall - before, wall - after];
    const valid = candidates
      .filter((instant) => wallClockMs(format, instant) === wall)
      .sort((left, right) => left - right);
    const earliest = valid[0];
    if (earliest !== undefined) return new Date(earliest).toISOString();
    return new Date(wall + (after - before) - after).toISOString();
  } catch {
    return null;
  }
}

function stripFraction(local: string): string {
  return local.replace(/\.\d+$/, "");
}

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
    format.format(new Date(0));
  } catch (error) {
    throw new ScreenpipeConnectorError(
      "misconfigured",
      "kizuki.screenpipe: config.timezone is not a recognized IANA name",
      { cause: error },
    );
  }
  ZONE_FORMATTERS.set(timeZone, format);
  return format;
}

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
