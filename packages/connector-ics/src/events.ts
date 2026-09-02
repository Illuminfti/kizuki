import type { CaptureEventInput } from "@kizuki/core";
import {
  formatLocal,
  formatLocalDate,
  intlZones,
  localToMs,
  msToLocal,
  parseDateTime,
  toUtc,
} from "./datetime";
import type { IcsInstant, LocalDateTime } from "./datetime";
import {
  emit,
  instantOf,
  isCancelled,
  localOf,
  parseDuration,
  single,
  slugify,
  synthesizeUid,
} from "./map";
import type { EmitInput, MapOptions } from "./map";
import { allValues, firstValue, unescapeText } from "./parse";
import type { ParsedCalendar, RawVEvent } from "./parse";
import { expand, parseRrule } from "./rrule";

export const MAX_INSTANCES = 1_000;
export const MAX_STEPS = 100_000;
export const WINDOW_DAYS = 365;

function exdateKeys(event: RawVEvent): Set<string> {
  const keys = new Set<string>();
  for (const line of allValues(event, "EXDATE")) {
    for (const piece of line.value.split(",")) {
      const instant = parseDateTime(piece, single(line.params));
      keys.add(formatLocal(localOf(instant)));
    }
  }
  return keys;
}

function rdateLocals(event: RawVEvent): LocalDateTime[] {
  const locals: LocalDateTime[] = [];
  for (const line of allValues(event, "RDATE")) {
    for (const piece of line.value.split(",")) {
      locals.push(localOf(parseDateTime(piece, single(line.params))));
    }
  }
  return locals;
}

interface Series {
  master: RawVEvent;
  overrides: RawVEvent[];
}

function seriesByUid(
  parsed: ParsedCalendar,
  duplicates: Set<string>,
): Map<string, Series> {
  const series = new Map<string, Series>();
  for (const event of parsed.events) {
    const uidLine = firstValue(event, "UID");
    const summary = unescapeText(firstValue(event, "SUMMARY")?.value ?? "");
    const dtstart = firstValue(event, "DTSTART")?.value ?? "";
    const uid =
      uidLine === undefined || uidLine.value.trim().length === 0
        ? synthesizeUid(dtstart, summary)
        : uidLine.value.trim();
    const existing = series.get(uid);
    const isOverride = firstValue(event, "RECURRENCE-ID") !== undefined;
    if (existing === undefined) {
      // An override with no master of its own stands in as the master; it is
      // emitted as its own instance rather than dropped.
      series.set(uid, { master: event, overrides: [] });
      continue;
    }
    if (isOverride) {
      existing.overrides.push(event);
      continue;
    }
    // Two masters under one id: the later definition is the live one.
    duplicates.add(uid);
    existing.master = event;
  }
  return series;
}

/** Turns a parsed calendar into the events the ledger stores. */
export function calendarEvents(
  parsed: ParsedCalendar,
  opts: MapOptions,
): CaptureEventInput[] {
  const duplicates = new Set<string>();
  const series = seriesByUid(parsed, duplicates);
  const calendarName = parsed.calendar.name;
  const calendarSlug = slugify(
    calendarName !== null && calendarName.length > 0
      ? calendarName
      : opts.slugSource,
  );
  const windowEnd = msToLocal(opts.now.getTime() + WINDOW_DAYS * 86_400_000);
  const events: CaptureEventInput[] = [];

  for (const [uid, entry] of series) {
    const master = entry.master;
    if (isCancelled(master) && entry.overrides.length === 0) continue;
    const startLine = firstValue(master, "DTSTART");
    const start = instantOf(startLine);
    if (start === null) continue;
    const synthesized =
      firstValue(master, "UID") === undefined ||
      (firstValue(master, "UID")?.value ?? "").trim().length === 0;
    const duplicate = duplicates.has(uid);

    const durationLine = firstValue(master, "DURATION");
    const dtend = instantOf(firstValue(master, "DTEND"));
    const zones = opts.zones ?? intlZones;
    const duration =
      durationLine !== undefined
        ? parseDuration(durationLine.value)
        : dtend !== null
          ? Math.round(
              (Date.parse(toUtc(dtend, zones, parsed.zones).iso) -
                Date.parse(toUtc(start, zones, parsed.zones).iso)) /
                1_000,
            )
          : null;

    const rruleLine = firstValue(master, "RRULE");
    const rdates = rdateLocals(master);
    const common = {
      uid,
      parsed,
      opts,
      calendarSlug,
      calendarName,
      duration,
      synthesized,
      duplicate,
    };

    if (rruleLine === undefined && rdates.length === 0) {
      if (!isCancelled(master)) events.push(emit({ ...common, event: master, start }));
      for (const override of entry.overrides) {
        pushOverride(events, override, common);
      }
      continue;
    }

    const parsedRule =
      rruleLine === undefined ? null : parseRrule(rruleLine.value);
    if (parsedRule !== null && "unsupported" in parsedRule) {
      events.push(
        emit({
          ...common,
          event: master,
          start,
          recurrence: {
            rrule: rruleLine?.value ?? null,
            instance_of: uid,
            expanded: false,
          },
        }),
      );
      continue;
    }

    const dtstartLocal = localOf(start);
    const expansion =
      parsedRule === null
        ? { instances: rdates, truncated: false }
        : expand(parsedRule.rule, dtstartLocal, {
            windowEnd,
            maxInstances: MAX_INSTANCES,
            exdates: exdateKeys(master),
            rdates,
            maxSteps: MAX_STEPS,
          });

    const overrideByStart = new Map<string, RawVEvent>();
    for (const override of entry.overrides) {
      const recurrenceId = instantOf(firstValue(override, "RECURRENCE-ID"));
      if (recurrenceId === null) continue;
      overrideByStart.set(formatLocal(localOf(recurrenceId)), override);
    }

    const emittedKeys = new Set<string>();
    for (const instance of expansion.instances) {
      const key = formatLocal(instance);
      emittedKeys.add(key);
      const override = overrideByStart.get(key);
      const source = override ?? master;
      if (isCancelled(source)) continue;
      // A rescheduled instance keeps the identity of the slot it replaces, so
      // the ledger records a move rather than a deletion plus a new event.
      const overrideStart =
        override === undefined
          ? null
          : instantOf(firstValue(override, "DTSTART"));
      events.push(
        emit({
          ...common,
          event: source,
          start: overrideStart ?? instanceStart(start, instance),
          ...(override !== undefined ? { suffixKey: key } : {}),
          recurrence: {
            rrule: rruleLine?.value ?? null,
            instance_of: uid,
            ...(override !== undefined ? { recurrence_id: key } : {}),
            expanded: true,
            ...(expansion.truncated ? { truncated: true } : {}),
          },
        }),
      );
    }
    for (const [key, override] of overrideByStart) {
      if (emittedKeys.has(key) || isCancelled(override)) continue;
      const overrideStart = instantOf(firstValue(override, "DTSTART")) ?? start;
      events.push(
        emit({
          ...common,
          event: override,
          start: overrideStart,
          recurrence: {
            rrule: rruleLine?.value ?? null,
            instance_of: uid,
            recurrence_id: key,
            expanded: true,
          },
        }),
      );
    }
  }

  events.sort((a, b) =>
    a.source_record_id < b.source_record_id
      ? -1
      : a.source_record_id > b.source_record_id
        ? 1
        : 0,
  );
  return events;
}

function pushOverride(
  events: CaptureEventInput[],
  override: RawVEvent,
  common: Omit<EmitInput, "event" | "start" | "recurrence">,
): void {
  if (isCancelled(override)) return;
  const start = instantOf(firstValue(override, "DTSTART"));
  if (start === null) return;
  const recurrenceId = instantOf(firstValue(override, "RECURRENCE-ID"));
  events.push(
    emit({
      ...common,
      event: override,
      start,
      recurrence: {
        rrule: null,
        instance_of: common.uid,
        ...(recurrenceId !== null
          ? { recurrence_id: formatLocal(localOf(recurrenceId)) }
          : {}),
        expanded: true,
      },
    }),
  );
}

function instanceStart(master: IcsInstant, local: LocalDateTime): IcsInstant {
  if (master.kind === "date")
    return { kind: "date", date: formatLocalDate(local) };
  if (master.kind === "zoned") {
    return { kind: "zoned", local: formatLocal(local), tzid: master.tzid };
  }
  if (master.kind === "floating") {
    return { kind: "floating", local: formatLocal(local) };
  }
  return { kind: "utc", iso: new Date(localToMs(local)).toISOString() };
}

