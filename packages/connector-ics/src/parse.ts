import { KizukiError } from "@kizuki/core";
import { unfold } from "./unfold";

export const MAX_COMPONENTS = 20_000;
export const MAX_NESTING = 8;

export interface ContentLine {
  /** Upper-cased property name. */
  name: string;
  /** Upper-cased parameter names to their (possibly multiple) values. */
  params: Record<string, string[]>;
  /** The raw value; TEXT properties go through `unescapeText`. */
  value: string;
}

export interface ZoneInfo {
  tzid: string;
  standardOffsetMinutes: number | null;
}

export interface RawVEvent {
  lines: ContentLine[];
}

export interface ParsedCalendar {
  calendar: {
    name: string | null;
    prodid: string | null;
  };
  zones: Map<string, ZoneInfo>;
  events: RawVEvent[];
}

const EVENT_PROPERTIES = new Set([
  "UID",
  "DTSTART",
  "DTEND",
  "DURATION",
  "SUMMARY",
  "DESCRIPTION",
  "LOCATION",
  "ORGANIZER",
  "ATTENDEE",
  "STATUS",
  "CLASS",
  "SEQUENCE",
  "CREATED",
  "LAST-MODIFIED",
  "URL",
  "RRULE",
  "RDATE",
  "EXDATE",
  "RECURRENCE-ID",
  "ATTACH",
]);

export function unescapeText(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      out += character;
      continue;
    }
    const next = value[index + 1] ?? "";
    index += 1;
    if (next === "n" || next === "N") out += "\n";
    else if (next === "," || next === ";" || next === "\\") out += next;
    else out += next;
  }
  return out;
}

function splitParams(head: string): {
  name: string;
  params: Record<string, string[]>;
} {
  const pieces: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of head) {
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === ";" && !quoted) {
      pieces.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  pieces.push(current);

  const name = (pieces.shift() ?? "").trim().toUpperCase();
  const params: Record<string, string[]> = {};
  for (const piece of pieces) {
    const separator = piece.indexOf("=");
    if (separator === -1) continue;
    const key = piece.slice(0, separator).trim().toUpperCase();
    const values: string[] = [];
    let value = "";
    let inQuotes = false;
    for (const character of piece.slice(separator + 1)) {
      if (character === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (character === "," && !inQuotes) {
        values.push(value);
        value = "";
        continue;
      }
      value += character;
    }
    values.push(value);
    if (key.length > 0) params[key] = values;
  }
  return { name, params };
}

export function parseContentLine(line: string): ContentLine | null {
  let colon = -1;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') quoted = !quoted;
    if (character === ":" && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return null;
  const { name, params } = splitParams(line.slice(0, colon));
  if (name.length === 0) return null;
  return { name, params, value: line.slice(colon + 1) };
}

export function firstValue(
  event: RawVEvent,
  name: string,
): ContentLine | undefined {
  return event.lines.find((line) => line.name === name);
}

export function allValues(event: RawVEvent, name: string): ContentLine[] {
  return event.lines.filter((line) => line.name === name);
}

function offsetMinutes(value: string): number | null {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value.trim());
  if (match === null) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

interface Frame {
  name: string;
  lines: ContentLine[];
}

/**
 * Reads the components this connector understands and skips the rest.
 * `VTODO`, `VJOURNAL`, `VFREEBUSY` and `VALARM` are not calendar events and
 * are not smuggled in as ones.
 */
export function parseIcs(text: string): ParsedCalendar {
  const stack: Frame[] = [];
  const events: RawVEvent[] = [];
  const zones = new Map<string, ZoneInfo>();
  const calendar: ParsedCalendar["calendar"] = {
    name: null,
    prodid: null,
  };
  let components = 0;
  let sawCalendar = false;
  let zone: ZoneInfo | null = null;
  let zoneSection: "STANDARD" | "DAYLIGHT" | null = null;

  for (const raw of unfold(text)) {
    const line = parseContentLine(raw);
    if (line === null) continue;

    if (line.name === "BEGIN") {
      const component = line.value.trim().toUpperCase();
      components += 1;
      if (components > MAX_COMPONENTS) {
        throw new KizukiError(
          "parse_error",
          "kizuki.ics: calendar has too many components",
        );
      }
      // A document with content outside one VCALENDAR root, or with a second
      // root, is not a calendar this connector can read as authoritative.
      if (stack.length === 0 && component !== "VCALENDAR") {
        throw new KizukiError(
          "parse_error",
          "kizuki.ics: no VCALENDAR component around the calendar content",
        );
      }
      if (stack.length === 0 && sawCalendar) {
        throw new KizukiError(
          "parse_error",
          "kizuki.ics: more than one VCALENDAR component",
        );
      }
      stack.push({ name: component, lines: [] });
      if (stack.length > MAX_NESTING) {
        throw new KizukiError(
          "parse_error",
          "kizuki.ics: calendar components nest too deeply",
        );
      }
      if (component === "VCALENDAR") sawCalendar = true;
      if (component === "VTIMEZONE") {
        zone = { tzid: "", standardOffsetMinutes: null };
      }
      if (component === "STANDARD" || component === "DAYLIGHT") {
        zoneSection = component;
      }
      continue;
    }

    if (line.name === "END") {
      const component = line.value.trim().toUpperCase();
      const frame = stack.pop();
      // An END that names something other than the open component means the
      // document is torn; reading past it would invent a calendar.
      if (frame === undefined || frame.name !== component) {
        throw new KizukiError(
          "parse_error",
          "kizuki.ics: calendar components are not balanced",
        );
      }
      if (component === "VEVENT") events.push({ lines: frame.lines });
      if (component === "VTIMEZONE" && zone !== null) {
        if (zone.tzid.length > 0) zones.set(zone.tzid, zone);
        zone = null;
      }
      if (component === "STANDARD" || component === "DAYLIGHT") {
        zoneSection = null;
      }
      continue;
    }

    const frame = stack[stack.length - 1];
    if (frame === undefined) continue;

    if (frame.name === "VCALENDAR") {
      if (line.name === "X-WR-CALNAME")
        calendar.name = unescapeText(line.value);
      if (line.name === "PRODID") calendar.prodid = unescapeText(line.value);
      continue;
    }
    if (zone !== null) {
      if (line.name === "TZID" && frame.name === "VTIMEZONE") {
        zone.tzid = line.value.trim();
      }
      // Only the standard offset is read: the resolver falls back to a fixed
      // offset for a zone the platform does not know, and a fixed offset that
      // changed twice a year would not be one.
      if (line.name === "TZOFFSETTO" && zoneSection === "STANDARD") {
        zone.standardOffsetMinutes = offsetMinutes(line.value);
      }
      continue;
    }
    if (frame.name === "VEVENT" && EVENT_PROPERTIES.has(line.name)) {
      frame.lines.push(line);
    }
  }

  if (!sawCalendar) {
    throw new KizukiError("parse_error", "kizuki.ics: no VCALENDAR component");
  }
  // A half-downloaded feed ends mid-component. Accepting it would report a
  // truncated calendar as an authoritative snapshot, and every event the
  // truncation cut off would be tombstoned on the next sync.
  if (stack.length > 0) {
    throw new KizukiError(
      "parse_error",
      "kizuki.ics: calendar ends inside a component",
    );
  }
  return { calendar, zones, events };
}
