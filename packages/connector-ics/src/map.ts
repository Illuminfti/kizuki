import type {
  AttachmentRef,
  CaptureEventInput,
  SensitivityHint,
  SubjectRef,
} from "@kizuki/core";
import {
  formatLocal,
  formatLocalDate,
  intlZones,
  msToLocal,
  parseDateTime,
  parseLocal,
  toUtc,
} from "./datetime";
import type { IcsInstant, LocalDateTime, ZoneResolver } from "./datetime";
import { allValues, firstValue, unescapeText } from "./parse";
import type { ContentLine, ParsedCalendar, RawVEvent } from "./parse";

export const ICS_CONNECTOR_ID = "kizuki.ics" as const;
export const MAX_TEXT_CODE_POINTS = 262_144;
export const MAX_DISPLAY_NAME_CHARS = 120;
export const MAX_SLUG_CHARS = 64;

export interface MapOptions {
  /** File base name or URL hostname; only used when the file has no name. */
  slugSource: string;
  observedAt: string;
  now: Date;
  zones?: ZoneResolver;
}

export function single(params: Record<string, string[]>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, values] of Object.entries(params)) {
    const first = values[0];
    if (first !== undefined) flat[key] = first;
  }
  return flat;
}

function sanitize(text: string, limit: number): string {
  const cleaned = Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  return Array.from(cleaned).slice(0, limit).join("");
}

export function slugify(name: string): string {
  return sanitize(name, MAX_SLUG_CHARS)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, MAX_SLUG_CHARS);
}

export function synthesizeUid(dtstart: string, summary: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${dtstart}\n${summary}`)
    .digest("hex")
    .slice(0, 16);
}

const DURATION =
  /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseDuration(value: string): number | null {
  const match = DURATION.exec(value.trim().toUpperCase());
  if (match === null) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const seconds =
    Number(match[2] ?? 0) * 604_800 +
    Number(match[3] ?? 0) * 86_400 +
    Number(match[4] ?? 0) * 3_600 +
    Number(match[5] ?? 0) * 60 +
    Number(match[6] ?? 0);
  return sign * seconds;
}

function mailtoAddress(value: string): string | null {
  const match = /^mailto:(.+)$/i.exec(value.trim());
  if (match === null) return null;
  const address = (match[1] ?? "").trim();
  return address.split("@").length === 2 && !/\s/.test(address)
    ? address
    : null;
}

function personSubject(
  line: ContentLine,
  role: "from" | "to",
): SubjectRef | null {
  const address = mailtoAddress(line.value);
  if (address === null) return null;
  const name = sanitize(line.params["CN"]?.[0] ?? "", MAX_DISPLAY_NAME_CHARS);
  return {
    subject_id: `email:${address.toLowerCase()}`,
    role,
    ...(name.length > 0 ? { display_name: name } : {}),
  };
}

function hintFor(event: RawVEvent): SensitivityHint {
  const klass = (firstValue(event, "CLASS")?.value ?? "").trim().toUpperCase();
  if (klass === "PUBLIC") return "public";
  if (klass === "PRIVATE" || klass === "CONFIDENTIAL") return "private";
  return "personal";
}

function attachmentsFor(event: RawVEvent): AttachmentRef[] {
  return allValues(event, "ATTACH").map((line, index) => {
    const encoding = (line.params["ENCODING"]?.[0] ?? "").toUpperCase();
    const inline = encoding === "BASE64";
    const filename = inline
      ? ""
      : sanitize(
          decodeURIComponent(
            (line.value.split("?")[0] ?? "").split("/").pop() ?? "",
          ).replace(/[/\\]/g, ""),
          255,
        );
    return {
      attachment_id: `attach-${index + 1}`,
      media_type: line.params["FMTTYPE"]?.[0] ?? "application/octet-stream",
      ...(filename.length > 0 ? { filename } : {}),
      // Inline payloads are measured, never stored: the ledger holds refs.
      ...(inline
        ? {
            byte_size: Math.floor(
              (line.value.replace(/=+$/, "").length * 3) / 4,
            ),
          }
        : {}),
    };
  });
}

export function instantOf(line: ContentLine | undefined): IcsInstant | null {
  if (line === undefined) return null;
  return parseDateTime(line.value, single(line.params));
}

export function localOf(instant: IcsInstant): LocalDateTime {
  if (instant.kind === "date") return parseLocal(instant.date);
  if (instant.kind === "utc") return msToLocal(Date.parse(instant.iso));
  return parseLocal(instant.local);
}

export function textFor(event: RawVEvent): string {
  const summary = unescapeText(
    firstValue(event, "SUMMARY")?.value ?? "",
  ).trim();
  const description = unescapeText(
    firstValue(event, "DESCRIPTION")?.value ?? "",
  ).trim();
  const location = unescapeText(
    firstValue(event, "LOCATION")?.value ?? "",
  ).trim();
  const pieces = [summary.length > 0 ? summary : "(no title)"];
  if (description.length > 0) pieces.push(description);
  if (location.length > 0) pieces.push(`Location: ${location}`);
  const joined = pieces.join("\n\n");
  const points = Array.from(joined);
  return points.length > MAX_TEXT_CODE_POINTS
    ? points.slice(0, MAX_TEXT_CODE_POINTS).join("")
    : joined;
}

export interface EmitInput {
  uid: string;
  event: RawVEvent;
  start: IcsInstant;
  parsed: ParsedCalendar;
  opts: MapOptions;
  calendarSlug: string;
  calendarName: string | null;
  duration: number | null;
  recurrence?: Record<string, unknown>;
  /** Identity of the slot in the series, when it differs from the start. */
  suffixKey?: string;
  synthesized: boolean;
  duplicate: boolean;
}

export function emit(input: EmitInput): CaptureEventInput {
  const zones = input.opts.zones ?? intlZones;
  const converted = toUtc(input.start, zones, input.parsed.zones);
  const allDay = input.start.kind === "date";
  const startMs = Date.parse(converted.iso);
  const endInstant = instantOf(firstValue(input.event, "DTEND"));
  const endsAt =
    endInstant !== null && input.recurrence === undefined
      ? toUtc(endInstant, zones, input.parsed.zones).iso
      : input.duration !== null
        ? new Date(startMs + input.duration * 1_000).toISOString()
        : null;

  const subjects: SubjectRef[] = [];
  const organizer = firstValue(input.event, "ORGANIZER");
  if (organizer !== undefined) {
    const subject = personSubject(organizer, "from");
    if (subject !== null) subjects.push(subject);
  }
  for (const attendee of allValues(input.event, "ATTENDEE")) {
    const subject = personSubject(attendee, "to");
    if (subject !== null) subjects.push(subject);
  }
  subjects.push({
    subject_id: `calendar:${input.calendarSlug}`,
    role: "about",
  });

  // Only a generated instance carries a start suffix; an unexpanded master
  // keeps the bare UID so it stays one record rather than a series of one.
  const expanded = input.recurrence?.["expanded"] === true;
  const suffix = !expanded
    ? ""
    : `#${input.suffixKey ?? (allDay ? formatLocalDate(localOf(input.start)) : formatLocal(localOf(input.start)))}`;

  const tzid = input.start.kind === "zoned" ? input.start.tzid : undefined;
  const created = instantOf(firstValue(input.event, "CREATED"));
  const lastModified = instantOf(firstValue(input.event, "LAST-MODIFIED"));
  const url = firstValue(input.event, "URL")?.value;
  const sequence = Number(firstValue(input.event, "SEQUENCE")?.value ?? "0");

  return {
    schema: "kizuki.event/v1",
    connector_id: ICS_CONNECTOR_ID,
    source_record_id: `${input.uid}${suffix}`,
    kind: "calendar_event",
    occurred_at: converted.iso,
    observed_at: input.opts.observedAt,
    text: textFor(input.event),
    subjects,
    sensitivity_hint: hintFor(input.event),
    deleted: false,
    attachments: attachmentsFor(input.event),
    metadata: {
      uid: input.uid,
      sequence: Number.isFinite(sequence) ? sequence : 0,
      status:
        (firstValue(input.event, "STATUS")?.value ?? "").trim().toUpperCase() ||
        null,
      location:
        unescapeText(firstValue(input.event, "LOCATION")?.value ?? "").trim() ||
        null,
      ends_at: endsAt,
      all_day: allDay,
      ...(allDay && endInstant?.kind === "date"
        ? { ends_on: endInstant.date }
        : {}),
      ...(input.duration !== null ? { duration: input.duration } : {}),
      tz: {
        ...(tzid !== undefined ? { tzid } : {}),
        approximation: converted.approximation,
      },
      ...(input.recurrence !== undefined
        ? { recurrence: input.recurrence }
        : {}),
      ...(created !== null
        ? { created: toUtc(created, zones, input.parsed.zones).iso }
        : {}),
      ...(lastModified !== null
        ? { last_modified: toUtc(lastModified, zones, input.parsed.zones).iso }
        : {}),
      ...(url !== undefined && url.length > 0 ? { url } : {}),
      ...(input.calendarName !== null
        ? { calendar_name: input.calendarName }
        : {}),
      ...(input.synthesized ? { uid_synthesized: true } : {}),
      ...(input.duplicate ? { duplicate_uid: true } : {}),
    },
  };
}

export function isCancelled(event: RawVEvent): boolean {
  return (
    (firstValue(event, "STATUS")?.value ?? "").trim().toUpperCase() ===
    "CANCELLED"
  );
}

export function tombstone(
  sourceRecordId: string,
  metadata: Record<string, unknown>,
  observedAt: string,
): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: ICS_CONNECTOR_ID,
    source_record_id: sourceRecordId,
    kind: "calendar_event",
    occurred_at: observedAt,
    observed_at: observedAt,
    text: "",
    subjects: [],
    deleted: true,
    attachments: [],
    metadata,
  };
}
