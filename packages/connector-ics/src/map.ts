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
/**
 * Metadata is stored verbatim per event, so a single hostile value repeated
 * across a calendar's entries is an amplification of the source's size.
 */
export const MAX_METADATA_VALUE_CHARS = 1_024;

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

/** Producer-controlled text is never shown or stored as it arrives. */
export function sanitize(text: string, limit: number): string {
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

/**
 * `#` separates a UID from an instance start in `source_record_id`, so a UID
 * that carries one is escaped first. Without this a crafted UID collides with
 * a generated instance of another series and the two share one ledger row.
 */
export function encodeUid(uid: string): string {
  return uid.replace(/[%#]/g, (character) =>
    character === "#" ? "%23" : "%25",
  );
}

export function decodeUid(value: string): string {
  return value.replace(/%(23|25)/g, (_match, code: string) =>
    code === "23" ? "#" : "%",
  );
}

export function synthesizeUid(dtstart: string, summary: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${dtstart}\n${summary}`)
    .digest("hex")
    .slice(0, 16);
}

const DURATION =
  /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** A decade: past this a DURATION is hostile input, not a meeting length. */
export const MAX_DURATION_SECONDS = 10 * 365 * 86_400;

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
  if (!Number.isSafeInteger(seconds) || seconds > MAX_DURATION_SECONDS) {
    return null;
  }
  return sign * seconds;
}

/** A URI segment may carry a broken escape; the raw text beats an exception. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A control character is stripped out of a display name but must never be
 * carried into a subject id: two identities that render alike in a terminal
 * would become two rows the owner cannot tell apart.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function mailtoAddress(value: string): string | null {
  const match = /^mailto:(.+)$/i.exec(value.trim());
  if (match === null) return null;
  const address = (match[1] ?? "").trim();
  return address.split("@").length === 2 &&
    !/\s/.test(address) &&
    !hasControlCharacter(address)
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

/**
 * One person listed twice, or under two spellings of the same address, is one
 * subject: a duplicate would otherwise become a second identical proposal.
 */
class SubjectList {
  private readonly byKey = new Map<string, SubjectRef>();

  add(subject: SubjectRef | null): void {
    if (subject === null) return;
    const key = `${subject.subject_id}\u0000${subject.role}`;
    const existing = this.byKey.get(key);
    if (existing === undefined) {
      this.byKey.set(key, subject);
      return;
    }
    // A later line may be the one that carries a usable name.
    if (existing.display_name === undefined && subject.display_name !== undefined) {
      this.byKey.set(key, subject);
    }
  }

  all(): SubjectRef[] {
    return [...this.byKey.values()];
  }
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
          decodeSegment(
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
  const durationEndMs =
    input.duration === null ? null : startMs + input.duration * 1_000;
  const endsAt =
    endInstant !== null && input.recurrence === undefined
      ? toUtc(endInstant, zones, input.parsed.zones).iso
      : durationEndMs !== null && Number.isFinite(new Date(durationEndMs).getTime())
        ? new Date(durationEndMs).toISOString()
        : null;

  const subjects = new SubjectList();
  const organizer = firstValue(input.event, "ORGANIZER");
  if (organizer !== undefined) subjects.add(personSubject(organizer, "from"));
  for (const attendee of allValues(input.event, "ATTENDEE")) {
    subjects.add(personSubject(attendee, "to"));
  }
  subjects.add({
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
  const url = sanitize(
    firstValue(input.event, "URL")?.value ?? "",
    MAX_METADATA_VALUE_CHARS,
  );
  const sequence = Number(firstValue(input.event, "SEQUENCE")?.value ?? "0");
  const calendarName = sanitize(
    input.calendarName ?? "",
    MAX_METADATA_VALUE_CHARS,
  );

  return {
    schema: "kizuki.event/v1",
    connector_id: ICS_CONNECTOR_ID,
    source_record_id: `${encodeUid(input.uid)}${suffix}`,
    kind: "calendar_event",
    occurred_at: converted.iso,
    observed_at: input.opts.observedAt,
    text: textFor(input.event),
    subjects: subjects.all(),
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
        sanitize(
          unescapeText(firstValue(input.event, "LOCATION")?.value ?? ""),
          MAX_METADATA_VALUE_CHARS,
        ) || null,
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
      ...(url.length > 0 ? { url } : {}),
      ...(calendarName.length > 0 ? { calendar_name: calendarName } : {}),
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
