import { KizukiError } from "@kizuki/core";
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
/** Used only when neither the calendar nor its source yields a usable slug. */
const FALLBACK_SLUG = "unnamed";
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

/**
 * RFC 5545 imposes no order on the components of a calendar, so the master and
 * its overrides are classified by RECURRENCE-ID rather than by which one the
 * file happens to list first.
 */
function seriesByUid(
  parsed: ParsedCalendar,
  duplicates: Set<string>,
): Map<string, Series> {
  const buckets = new Map<string, { masters: RawVEvent[]; overrides: RawVEvent[] }>();
  for (const event of parsed.events) {
    const uidLine = firstValue(event, "UID");
    const summary = unescapeText(firstValue(event, "SUMMARY")?.value ?? "");
    const dtstart = firstValue(event, "DTSTART")?.value ?? "";
    const uid =
      uidLine === undefined || uidLine.value.trim().length === 0
        ? synthesizeUid(dtstart, summary)
        : uidLine.value.trim();
    const bucket = buckets.get(uid) ?? { masters: [], overrides: [] };
    if (firstValue(event, "RECURRENCE-ID") !== undefined) {
      bucket.overrides.push(event);
    } else {
      bucket.masters.push(event);
    }
    buckets.set(uid, bucket);
  }

  const series = new Map<string, Series>();
  for (const [uid, bucket] of buckets) {
    // Two masters under one id: the later definition is the live one.
    if (bucket.masters.length > 1) duplicates.add(uid);
    const last = bucket.masters.at(-1);
    if (last !== undefined) {
      series.set(uid, { master: last, overrides: bucket.overrides });
      continue;
    }
    // An override with no master of its own stands in as the master; it is
    // emitted as its own instance rather than dropped.
    const first = bucket.overrides[0];
    if (first === undefined) continue;
    series.set(uid, { master: first, overrides: bucket.overrides.slice(1) });
  }
  return series;
}

export interface CalendarMapping {
  events: CaptureEventInput[];
  /** Entries whose own date values were unreadable and could not be mapped. */
  skipped: number;
  /**
   * UIDs of those entries. The calendar still carries them, so a sync must
   * not read their absence from the mapping as a deletion.
   */
  unreadableUids: string[];
}

interface SeriesContext {
  parsed: ParsedCalendar;
  opts: MapOptions;
  calendarSlug: string;
  calendarName: string | null;
  windowEnd: LocalDateTime;
  duplicates: Set<string>;
}

/** Turns a parsed calendar into the events the ledger stores. */
export function calendarEvents(
  parsed: ParsedCalendar,
  opts: MapOptions,
): CalendarMapping {
  const duplicates = new Set<string>();
  const series = seriesByUid(parsed, duplicates);
  const calendarName = parsed.calendar.name;
  // Emptiness is decided after sanitising: a name of nothing but spaces would
  // otherwise slug to "" and collapse every such calendar onto one identity.
  const calendarSlug =
    slugify(calendarName ?? "") || slugify(opts.slugSource) || FALLBACK_SLUG;
  const context: SeriesContext = {
    parsed,
    opts,
    calendarSlug,
    calendarName,
    windowEnd: msToLocal(opts.now.getTime() + WINDOW_DAYS * 86_400_000),
    duplicates,
  };
  const events: CaptureEventInput[] = [];
  const unreadableUids: string[] = [];

  for (const [uid, entry] of series) {
    try {
      events.push(...seriesEvents(uid, entry, context));
    } catch (error) {
      // One entry with an unreadable date must not cost the calendar: the
      // producer is a third party, and the rest of the file is still good.
      if (!(error instanceof KizukiError) || error.code !== "parse_error") {
        throw error;
      }
      unreadableUids.push(uid);
    }
  }

  events.sort((a, b) =>
    a.source_record_id < b.source_record_id
      ? -1
      : a.source_record_id > b.source_record_id
        ? 1
        : 0,
  );
  return { events, skipped: unreadableUids.length, unreadableUids };
}

function seriesEvents(
  uid: string,
  entry: Series,
  context: SeriesContext,
): CaptureEventInput[] {
  const { parsed, opts, calendarSlug, calendarName, windowEnd, duplicates } =
    context;
  const events: CaptureEventInput[] = [];
  const master = entry.master;
  if (isCancelled(master) && entry.overrides.length === 0) return events;
  const startLine = firstValue(master, "DTSTART");
  const start = instantOf(startLine);
  if (start === null) return events;
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
    return events;
  }

  const parsedRule =
    rruleLine === undefined ? null : parseRrule(rruleLine.value);
  // RANGE=THISANDFUTURE rewrites the tail of the series, which this expansion
  // does not model; the master goes out once rather than as a wrong series.
  const rewritesTheTail = entry.overrides.some(
    (override) =>
      (firstValue(override, "RECURRENCE-ID")?.params["RANGE"]?.[0] ?? "")
        .trim()
        .toUpperCase() === "THISANDFUTURE",
  );
  if ((parsedRule !== null && "unsupported" in parsedRule) || rewritesTheTail) {
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
    return events;
  }

  const dtstartLocal = localOf(start);
  // A series that begins past the window would expand to nothing and vanish
  // with no error, while an identical one-off event at the same date is kept.
  // The window always reaches at least the series' own first instance.
  const seriesWindowEnd =
    localToMs(dtstartLocal) > localToMs(windowEnd) ? dtstartLocal : windowEnd;
  const expansion =
    parsedRule === null
      ? // RFC 5545 §3.8.5.2: RDATE adds to the recurrence set, which always
        // contains DTSTART.
        withStart(
          dtstartLocal,
          rdates,
          exdateKeys(master),
          seriesWindowEnd,
        )
      : expand(parsedRule.rule, dtstartLocal, {
          windowEnd: seriesWindowEnd,
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
          // The flag belongs to the series, not to the instances that made the
          // cut, so an override outside the kept window carries it too.
          ...(expansion.truncated ? { truncated: true } : {}),
        },
      }),
    );
  }
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

/**
 * An RDATE-only series is a recurrence set like any other, so it obeys the
 * same window and the same instance cap; a calendar listing thousands of
 * dates must not be able to buy unbounded ledger rows.
 */
function withStart(
  dtstart: LocalDateTime,
  rdates: LocalDateTime[],
  exdates: Set<string>,
  windowEnd: LocalDateTime,
): { instances: LocalDateTime[]; truncated: boolean } {
  const limitMs = localToMs(windowEnd);
  const byKey = new Map<string, LocalDateTime>();
  for (const local of [dtstart, ...rdates]) {
    const key = formatLocal(local);
    if (exdates.has(key)) continue;
    if (localToMs(local) > limitMs) continue;
    if (!byKey.has(key)) byKey.set(key, local);
  }
  const sorted = [...byKey.values()].sort((a, b) => localToMs(a) - localToMs(b));
  return sorted.length > MAX_INSTANCES
    ? { instances: sorted.slice(-MAX_INSTANCES), truncated: true }
    : { instances: sorted, truncated: false };
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
