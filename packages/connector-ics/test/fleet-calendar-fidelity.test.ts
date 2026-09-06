import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEventInput } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { calendarEvents, createIcsConnector, parseIcs } from "../src/index";

/** Ingest clock. Distinct from every scheduled start in this file. */
const OBSERVED_AT = "2026-09-01T12:00:00.000Z";
const LATER_OBSERVED_AT = "2026-09-02T08:30:00.000Z";
const CANCEL_OBSERVED_AT = "2026-09-03T09:00:00.000Z";

const ABOUT = {
  subject_id: "calendar:fleet-calendar",
  role: "about",
} as const;

function document(body: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "X-WR-CALNAME:Fleet calendar",
    ...body,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function vevent(lines: string[]): string[] {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
}

function mapAt(body: string[], observedAt: string): CaptureEventInput[] {
  const events = calendarEvents(parseIcs(document(body)), {
    slugSource: "unused-label",
    observedAt,
    now: new Date(observedAt),
  }).events;
  for (const event of events) {
    expect(validateEventInput(event).ok).toBe(true);
  }
  return events;
}

function map(body: string[]): CaptureEventInput[] {
  return mapAt(body, OBSERVED_AT);
}

function schedule(event: CaptureEventInput) {
  return {
    source_record_id: event.source_record_id,
    occurred_at: event.occurred_at,
    observed_at: event.observed_at,
    text: event.text,
    all_day: event.metadata["all_day"],
    tz: event.metadata["tz"],
    recurrence: event.metadata["recurrence"],
  };
}

const STARTS = [
  ...vevent([
    "UID:zoned-dst@fleet.example",
    "DTSTART;TZID=Europe/Berlin:20260329T100000",
    "DTEND;TZID=Europe/Berlin:20260329T110000",
    "SUMMARY:DST standup",
  ]),
  ...vevent([
    "UID:holiday@fleet.example",
    "DTSTART;VALUE=DATE:20260401",
    "DTEND;VALUE=DATE:20260403",
    "SUMMARY:Spring holiday",
  ]),
  ...vevent([
    "UID:float-1@fleet.example",
    "DTSTART:20260410T150000",
    "DTEND:20260410T163000",
    "SUMMARY:Floating review",
  ]),
  ...vevent([
    "UID:called-off@fleet.example",
    "DTSTART:20260412T090000Z",
    "DTEND:20260412T093000Z",
    "STATUS:CANCELLED",
    "SUMMARY:Called off",
  ]),
];

const ZONED_DST: CaptureEventInput = {
  schema: "kizuki.event/v1",
  connector_id: "kizuki.ics",
  source_record_id: "zoned-dst@fleet.example",
  kind: "calendar_event",
  occurred_at: "2026-03-29T08:00:00.000Z",
  observed_at: OBSERVED_AT,
  text: "DST standup",
  subjects: [ABOUT],
  sensitivity_hint: "personal",
  deleted: false,
  attachments: [],
  metadata: {
    uid: "zoned-dst@fleet.example",
    sequence: 0,
    status: null,
    location: null,
    ends_at: "2026-03-29T09:00:00.000Z",
    all_day: false,
    duration: 3_600,
    tz: { tzid: "Europe/Berlin", approximation: "none" },
    calendar_name: "Fleet calendar",
  },
};

const ALL_DAY: CaptureEventInput = {
  schema: "kizuki.event/v1",
  connector_id: "kizuki.ics",
  source_record_id: "holiday@fleet.example",
  kind: "calendar_event",
  occurred_at: "2026-04-01T00:00:00.000Z",
  observed_at: OBSERVED_AT,
  text: "Spring holiday",
  subjects: [ABOUT],
  sensitivity_hint: "personal",
  deleted: false,
  attachments: [],
  metadata: {
    uid: "holiday@fleet.example",
    sequence: 0,
    status: null,
    location: null,
    ends_at: "2026-04-03T00:00:00.000Z",
    all_day: true,
    ends_on: "20260403",
    duration: 172_800,
    tz: { approximation: "none" },
    calendar_name: "Fleet calendar",
  },
};

const FLOATING: CaptureEventInput = {
  schema: "kizuki.event/v1",
  connector_id: "kizuki.ics",
  source_record_id: "float-1@fleet.example",
  kind: "calendar_event",
  occurred_at: "2026-04-10T15:00:00.000Z",
  observed_at: OBSERVED_AT,
  text: "Floating review",
  subjects: [ABOUT],
  sensitivity_hint: "personal",
  deleted: false,
  attachments: [],
  metadata: {
    uid: "float-1@fleet.example",
    sequence: 0,
    status: null,
    location: null,
    ends_at: "2026-04-10T16:30:00.000Z",
    all_day: false,
    duration: 5_400,
    tz: { approximation: "floating" },
    calendar_name: "Fleet calendar",
  },
};

const WEEKLY = [
  ...vevent([
    "UID:standup@fleet.example",
    "DTSTART;TZID=Europe/Berlin:20260318T100000",
    "DTEND;TZID=Europe/Berlin:20260318T110000",
    "RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=WE",
    "EXDATE;TZID=Europe/Berlin:20260325T100000",
    "SUMMARY:Standup",
  ]),
  ...vevent([
    "UID:standup@fleet.example",
    "RECURRENCE-ID;TZID=Europe/Berlin:20260401T100000",
    "DTSTART;TZID=Europe/Berlin:20260401T140000",
    "DTEND;TZID=Europe/Berlin:20260401T150000",
    "SUMMARY:Standup moved",
  ]),
];

const INSTANCE_CANCEL = [
  ...vevent([
    "UID:briefing@fleet.example",
    "DTSTART:20260406T140000Z",
    "DTEND:20260406T143000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "SUMMARY:Briefing",
  ]),
  ...vevent([
    "UID:briefing@fleet.example",
    "RECURRENCE-ID:20260407T140000Z",
    "DTSTART:20260407T140000Z",
    "STATUS:CANCELLED",
    "SUMMARY:Briefing",
  ]),
  ...vevent([
    "UID:never-series@fleet.example",
    "DTSTART:20260401T090000Z",
    "RRULE:FREQ=DAILY;COUNT=5",
    "STATUS:CANCELLED",
    "SUMMARY:Never happened",
  ]),
];

const ALL_DAY_SERIES = [
  ...vevent([
    "UID:offsite@fleet.example",
    "DTSTART;VALUE=DATE:20260511",
    "DTEND;VALUE=DATE:20260512",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "EXDATE;VALUE=DATE:20260518",
    "SUMMARY:Offsite",
  ]),
];

describe("parse/map public seam", () => {
  test("zoned, all-day and floating starts keep scheduled time distinct from observation", () => {
    const events = map(STARTS);
    expect(events).toEqual([FLOATING, ALL_DAY, ZONED_DST]);
    for (const event of events) {
      expect(event.occurred_at).not.toBe(event.observed_at);
      expect(event.observed_at).toBe(OBSERVED_AT);
    }
    expect(events.map((event) => event.source_record_id)).not.toContain(
      "called-off@fleet.example",
    );
  });

  test("a later observation does not move scheduled starts or source identities", () => {
    const first = mapAt(STARTS, OBSERVED_AT);
    const later = mapAt(STARTS, LATER_OBSERVED_AT);
    expect(later.map((event) => event.source_record_id)).toEqual(
      first.map((event) => event.source_record_id),
    );
    expect(later.map((event) => event.occurred_at)).toEqual(
      first.map((event) => event.occurred_at),
    );
    expect(new Set(later.map((event) => event.observed_at))).toEqual(
      new Set([LATER_OBSERVED_AT]),
    );
  });

  test("a zoned weekly series drops EXDATE, keeps civil time across DST and the slot identity of a moved instance", () => {
    const events = map(WEEKLY);
    expect(events.map(schedule)).toEqual([
      {
        source_record_id: "standup@fleet.example#20260318T100000",
        occurred_at: "2026-03-18T09:00:00.000Z",
        observed_at: OBSERVED_AT,
        text: "Standup",
        all_day: false,
        tz: { tzid: "Europe/Berlin", approximation: "none" },
        recurrence: {
          rrule: "FREQ=WEEKLY;COUNT=4;BYDAY=WE",
          instance_of: "standup@fleet.example",
          expanded: true,
        },
      },
      {
        source_record_id: "standup@fleet.example#20260401T100000",
        occurred_at: "2026-04-01T12:00:00.000Z",
        observed_at: OBSERVED_AT,
        text: "Standup moved",
        all_day: false,
        tz: { tzid: "Europe/Berlin", approximation: "none" },
        recurrence: {
          rrule: "FREQ=WEEKLY;COUNT=4;BYDAY=WE",
          instance_of: "standup@fleet.example",
          recurrence_id: "20260401T100000",
          expanded: true,
        },
      },
      {
        source_record_id: "standup@fleet.example#20260408T100000",
        occurred_at: "2026-04-08T08:00:00.000Z",
        observed_at: OBSERVED_AT,
        text: "Standup",
        all_day: false,
        tz: { tzid: "Europe/Berlin", approximation: "none" },
        recurrence: {
          rrule: "FREQ=WEEKLY;COUNT=4;BYDAY=WE",
          instance_of: "standup@fleet.example",
          expanded: true,
        },
      },
    ]);
    expect(events.map((event) => event.source_record_id)).not.toContain(
      "standup@fleet.example#20260325T100000",
    );
    expect(events.map((event) => event.source_record_id)).not.toContain(
      "standup@fleet.example#20260401T140000",
    );
  });

  test("STATUS:CANCELLED omits a series and one instance without shifting siblings", () => {
    const events = map(INSTANCE_CANCEL);
    expect(events.map(schedule)).toEqual([
      {
        source_record_id: "briefing@fleet.example#20260406T140000",
        occurred_at: "2026-04-06T14:00:00.000Z",
        observed_at: OBSERVED_AT,
        text: "Briefing",
        all_day: false,
        tz: { approximation: "none" },
        recurrence: {
          rrule: "FREQ=DAILY;COUNT=3",
          instance_of: "briefing@fleet.example",
          expanded: true,
        },
      },
      {
        source_record_id: "briefing@fleet.example#20260408T140000",
        occurred_at: "2026-04-08T14:00:00.000Z",
        observed_at: OBSERVED_AT,
        text: "Briefing",
        all_day: false,
        tz: { approximation: "none" },
        recurrence: {
          rrule: "FREQ=DAILY;COUNT=3",
          instance_of: "briefing@fleet.example",
          expanded: true,
        },
      },
    ]);
    expect(events.map((event) => event.source_record_id)).not.toContain(
      "briefing@fleet.example#20260407T140000",
    );
    expect(events.map((event) => event.metadata["uid"])).not.toContain(
      "never-series@fleet.example",
    );
  });

  test("an all-day series uses date instance identities and drops an EXDATE day", () => {
    const events = map(ALL_DAY_SERIES);
    expect(events.map(schedule)).toEqual([
      {
        source_record_id: "offsite@fleet.example#20260511",
        occurred_at: "2026-05-11T00:00:00.000Z",
        observed_at: OBSERVED_AT,
        text: "Offsite",
        all_day: true,
        tz: { approximation: "none" },
        recurrence: {
          rrule: "FREQ=WEEKLY;COUNT=3",
          instance_of: "offsite@fleet.example",
          expanded: true,
        },
      },
      {
        source_record_id: "offsite@fleet.example#20260525",
        occurred_at: "2026-05-25T00:00:00.000Z",
        observed_at: OBSERVED_AT,
        text: "Offsite",
        all_day: true,
        tz: { approximation: "none" },
        recurrence: {
          rrule: "FREQ=WEEKLY;COUNT=3",
          instance_of: "offsite@fleet.example",
          expanded: true,
        },
      },
    ]);
    expect(events.map((event) => event.source_record_id)).not.toContain(
      "offsite@fleet.example#20260518",
    );
    expect(events.map((event) => event.source_record_id)).not.toContain(
      "offsite@fleet.example#20260511T000000",
    );
  });
});

describe("connector public seam", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function writeCalendar(text: string): Promise<string> {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ics-fidelity-"));
    directories.push(directory);
    const path = join(directory, "fleet.ics");
    await Bun.write(path, text);
    return path;
  }

  test("STATUS:CANCELLED tombstones the prior source identity at observation time", async () => {
    const live = document(
      vevent([
        "UID:review@fleet.example",
        "DTSTART:20260410T150000Z",
        "DTEND:20260410T160000Z",
        "SUMMARY:Review",
      ]),
    );
    const path = await writeCalendar(live);
    let clock = new Date(OBSERVED_AT);
    const connector = createIcsConnector({ path }, { now: () => clock });

    const first = await connector.backfill(null);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.source_record_id).toBe("review@fleet.example");
    expect(first.events[0]?.occurred_at).toBe("2026-04-10T15:00:00.000Z");
    expect(first.events[0]?.observed_at).toBe(OBSERVED_AT);
    expect(first.events[0]?.deleted).toBe(false);

    await Bun.write(
      path,
      live.replace("SUMMARY:Review", "STATUS:CANCELLED\r\nSUMMARY:Review"),
    );
    clock = new Date(CANCEL_OBSERVED_AT);
    const second = await connector.sync(first.cursor);
    expect(second.events).toEqual([
      {
        schema: "kizuki.event/v1",
        connector_id: "kizuki.ics",
        source_record_id: "review@fleet.example",
        kind: "calendar_event",
        occurred_at: CANCEL_OBSERVED_AT,
        observed_at: CANCEL_OBSERVED_AT,
        text: "",
        subjects: [],
        deleted: true,
        attachments: [],
        metadata: { uid: "review@fleet.example" },
      },
    ]);
    const tombstone = second.events[0];
    expect(tombstone).toBeDefined();
    if (tombstone === undefined) return;
    expect(validateEventInput(tombstone).ok).toBe(true);
  });

  test("cancelling one instance tombstones only that instance identity", async () => {
    const live = document(
      vevent([
        "UID:briefing@fleet.example",
        "DTSTART:20260406T140000Z",
        "DTEND:20260406T143000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        "SUMMARY:Briefing",
      ]),
    );
    const path = await writeCalendar(live);
    let clock = new Date(OBSERVED_AT);
    const connector = createIcsConnector({ path }, { now: () => clock });
    const first = await connector.backfill(null);
    expect(first.events.map((event) => event.source_record_id)).toEqual([
      "briefing@fleet.example#20260406T140000",
      "briefing@fleet.example#20260407T140000",
      "briefing@fleet.example#20260408T140000",
    ]);
    for (const event of first.events) {
      expect(event.occurred_at).not.toBe(event.observed_at);
      expect(event.observed_at).toBe(OBSERVED_AT);
    }

    await Bun.write(
      path,
      document([
        ...vevent([
          "UID:briefing@fleet.example",
          "DTSTART:20260406T140000Z",
          "DTEND:20260406T143000Z",
          "RRULE:FREQ=DAILY;COUNT=3",
          "SUMMARY:Briefing",
        ]),
        ...vevent([
          "UID:briefing@fleet.example",
          "RECURRENCE-ID:20260407T140000Z",
          "DTSTART:20260407T140000Z",
          "STATUS:CANCELLED",
          "SUMMARY:Briefing",
        ]),
      ]),
    );
    clock = new Date(CANCEL_OBSERVED_AT);
    const second = await connector.sync(first.cursor);
    expect(second.events).toEqual([
      {
        schema: "kizuki.event/v1",
        connector_id: "kizuki.ics",
        source_record_id: "briefing@fleet.example#20260407T140000",
        kind: "calendar_event",
        occurred_at: CANCEL_OBSERVED_AT,
        observed_at: CANCEL_OBSERVED_AT,
        text: "",
        subjects: [],
        deleted: true,
        attachments: [],
        metadata: {
          uid: "briefing@fleet.example",
          recurrence_id: "20260407T140000",
        },
      },
    ]);
  });
});
