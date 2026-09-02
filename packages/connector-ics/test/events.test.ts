import { describe, expect, test } from "bun:test";
import { validateEventInput } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { calendarEvents } from "../src/events";
import type { CalendarMapping } from "../src/events";
import {
  MAX_METADATA_VALUE_CHARS,
  parseDuration,
  slugify,
  synthesizeUid,
} from "../src/map";
import { parseIcs } from "../src/parse";
import { FIXTURE_NOW, fixtureIcsEvents } from "../src/fixture";

function byId(): Map<string, CaptureEventInput> {
  return new Map(
    fixtureIcsEvents().map((event) => [event.source_record_id, event]),
  );
}

function mapAll(body: string[], slugSource = "acme-team"): CalendarMapping {
  return calendarEvents(
    parseIcs(
      ["BEGIN:VCALENDAR", "VERSION:2.0", ...body, "END:VCALENDAR", ""].join(
        "\r\n",
      ),
    ),
    {
      slugSource,
      observedAt: "2026-03-01T00:00:00.000Z",
      now: FIXTURE_NOW,
    },
  );
}

function mapped(body: string[], slugSource = "acme-team"): CaptureEventInput[] {
  return mapAll(body, slugSource).events;
}

describe("the fixture calendar maps to exact events", () => {
  test("every event validates and none is cancelled", () => {
    const events = fixtureIcsEvents();
    expect(events.length).toBeGreaterThanOrEqual(8);
    for (const event of events) {
      expect(validateEventInput(event).ok).toBe(true);
      expect(event.kind).toBe("calendar_event");
      expect(event.connector_id).toBe("kizuki.ics");
      expect(event.deleted).toBe(false);
      expect(event.metadata["calendar_name"]).toBe("Acme team");
    }
    expect([...byId().keys()]).not.toContain("cancelled-1@acme.example");
  });

  test("a UTC event carries its text, location and end", () => {
    const event = byId().get("utc-1@acme.example");
    expect(event?.occurred_at).toBe("2026-03-02T09:00:00.000Z");
    expect(event?.text).toBe(
      "Sprint review\n\nDemo then retro.\n\nLocation: Room 2",
    );
    expect(event?.metadata).toMatchObject({
      ends_at: "2026-03-02T10:00:00.000Z",
      all_day: false,
      location: "Room 2",
      tz: { approximation: "none" },
    });
  });

  test("a zoned event resolves through the platform database", () => {
    const event = byId().get("berlin-1@acme.example");
    expect(event?.occurred_at).toBe("2026-07-03T08:00:00.000Z");
    expect(event?.metadata["tz"]).toEqual({
      tzid: "Europe/Berlin",
      approximation: "none",
    });
  });

  test("an all-day event is flagged and keeps its end date", () => {
    const event = byId().get("allday-1@acme.example");
    expect(event?.occurred_at).toBe("2026-03-15T00:00:00.000Z");
    expect(event?.metadata["all_day"]).toBe(true);
    expect(event?.metadata["ends_on"]).toBe("20260316");
  });

  test("the weekly series expands, drops the EXDATE and honours the override", () => {
    const ids = [...byId().keys()].filter((id) =>
      id.startsWith("weekly-1@acme.example#"),
    );
    expect(ids).toEqual([
      "weekly-1@acme.example#20260302T140000",
      "weekly-1@acme.example#20260309T140000",
      "weekly-1@acme.example#20260323T140000",
      "weekly-1@acme.example#20260330T140000",
    ]);
    const moved = byId().get("weekly-1@acme.example#20260323T140000");
    expect(moved?.text).toBe("Weekly sync (moved)");
    expect(moved?.occurred_at).toBe("2026-03-23T15:00:00.000Z");
    expect(moved?.metadata["recurrence"]).toEqual({
      rrule: "FREQ=WEEKLY;COUNT=5;BYDAY=MO",
      instance_of: "weekly-1@acme.example",
      recurrence_id: "20260323T140000",
      expanded: true,
    });
  });

  test("CLASS drives the sensitivity hint", () => {
    expect(byId().get("private-1@acme.example")?.sensitivity_hint).toBe(
      "private",
    );
    expect(byId().get("invite-1@acme.example")?.sensitivity_hint).toBe(
      "public",
    );
    expect(byId().get("utc-1@acme.example")?.sensitivity_hint).toBe("personal");
  });

  test("an organizer and attendees become subjects alongside the calendar", () => {
    expect(byId().get("invite-1@acme.example")?.subjects).toEqual([
      {
        subject_id: "email:ada@acme.example",
        role: "from",
        display_name: "Ada",
      },
      {
        subject_id: "email:grace@acme.example",
        role: "to",
        display_name: "Grace",
      },
      {
        subject_id: "email:linus@example.org",
        role: "to",
        display_name: "Linus",
      },
      { subject_id: "email:team@acme.example", role: "to" },
      { subject_id: "calendar:acme-team", role: "about" },
    ]);
  });

  test("an ATTACH becomes a ref with its media type and file name", () => {
    expect(byId().get("attach-1@acme.example")?.attachments).toEqual([
      {
        attachment_id: "attach-1",
        media_type: "application/pdf",
        filename: "agenda.pdf",
      },
    ]);
  });

  test("a zone only the file knows is marked as an approximation", () => {
    const event = byId().get("filezone-1@acme.example");
    expect(event?.occurred_at).toBe("2026-03-09T14:30:00.000Z");
    expect(event?.metadata["tz"]).toEqual({
      tzid: "Acme Standard Time",
      approximation: "vtimezone-fixed-offset",
    });
  });
});

describe("mapping edges", () => {
  test("an event with no UID gets a synthesized one and says so", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "DTSTART:20260302T090000Z",
      "SUMMARY:Anonymous",
      "END:VEVENT",
    ]);
    expect(events[0]?.source_record_id).toBe(
      synthesizeUid("20260302T090000Z", "Anonymous"),
    );
    expect(events[0]?.metadata["uid_synthesized"]).toBe(true);
  });

  test("a repeated UID keeps the last definition and flags it", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:dupe@acme.example",
      "DTSTART:20260302T090000Z",
      "SUMMARY:First",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:dupe@acme.example",
      "DTSTART:20260302T090000Z",
      "SUMMARY:Second",
      "END:VEVENT",
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("Second");
    expect(events[0]?.metadata["duplicate_uid"]).toBe(true);
  });

  test("an untitled event still has text", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:blank@acme.example",
      "DTSTART:20260302T090000Z",
      "END:VEVENT",
    ]);
    expect(events[0]?.text).toBe("(no title)");
  });

  test("an unsupported RRULE emits the master once and says it was not expanded", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:odd@acme.example",
      "DTSTART:20260302T090000Z",
      "RRULE:FREQ=DAILY;BYSETPOS=1",
      "SUMMARY:Complicated",
      "END:VEVENT",
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.source_record_id).toBe("odd@acme.example");
    expect(events[0]?.metadata["recurrence"]).toEqual({
      rrule: "FREQ=DAILY;BYSETPOS=1",
      instance_of: "odd@acme.example",
      expanded: false,
    });
  });

  test("a non-mailto organizer is skipped", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:room@acme.example",
      "DTSTART:20260302T090000Z",
      "ORGANIZER:https://acme.example/rooms/2",
      "ATTENDEE:mailto:grace@acme.example",
      "SUMMARY:Room booking",
      "END:VEVENT",
    ]);
    expect(events[0]?.subjects).toEqual([
      { subject_id: "email:grace@acme.example", role: "to" },
      { subject_id: "calendar:acme-team", role: "about" },
    ]);
  });

  test("the about slug falls back to the source when the file is unnamed", () => {
    const events = mapped(
      [
        "BEGIN:VEVENT",
        "UID:noname@acme.example",
        "DTSTART:20260302T090000Z",
        "END:VEVENT",
      ],
      "Team Calendar 2026!",
    );
    expect(events[0]?.subjects).toEqual([
      { subject_id: "calendar:team-calendar-2026-", role: "about" },
    ]);
  });

  test("an inline attachment contributes a size but is never stored", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:inline@acme.example",
      "DTSTART:20260302T090000Z",
      "ATTACH;ENCODING=BASE64;VALUE=BINARY:aGVsbG8gd29ybGQ=",
      "END:VEVENT",
    ]);
    expect(events[0]?.attachments).toEqual([
      {
        attachment_id: "attach-1",
        media_type: "application/octet-stream",
        byte_size: 11,
      },
    ]);
  });

  test("a malformed percent escape in ATTACH keeps the raw segment", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:standup@acme.example",
      "DTSTART:20260302T090000Z",
      "SUMMARY:Standup",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:hostile@acme.example",
      "DTSTART:20260302T100000Z",
      "ATTACH:https://files.example.org/invoice%zz.pdf",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:trailing@acme.example",
      "DTSTART:20260302T110000Z",
      "ATTACH:https://files.example.org/report%",
      "END:VEVENT",
    ]);
    expect(events.map((event) => event.source_record_id)).toEqual([
      "hostile@acme.example",
      "standup@acme.example",
      "trailing@acme.example",
    ]);
    expect(events[0]?.attachments).toEqual([
      {
        attachment_id: "attach-1",
        media_type: "application/octet-stream",
        filename: "invoice%zz.pdf",
      },
    ]);
    expect(events[2]?.attachments).toEqual([
      {
        attachment_id: "attach-1",
        media_type: "application/octet-stream",
        filename: "report%",
      },
    ]);
  });

  test("an override before its master still reschedules its instance", () => {
    const master = [
      "BEGIN:VEVENT",
      "UID:weekly@acme.example",
      "DTSTART:20260301T090000Z",
      "SUMMARY:Weekly",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "END:VEVENT",
    ];
    const override = [
      "BEGIN:VEVENT",
      "UID:weekly@acme.example",
      "RECURRENCE-ID:20260308T090000Z",
      "DTSTART:20260308T110000Z",
      "SUMMARY:Moved",
      "END:VEVENT",
    ];
    for (const body of [[...master, ...override], [...override, ...master]]) {
      const events = mapped(body);
      expect(events.map((event) => event.occurred_at)).toEqual([
        "2026-03-01T09:00:00.000Z",
        "2026-03-08T11:00:00.000Z",
        "2026-03-15T09:00:00.000Z",
      ]);
      expect(events[1]?.text.split("\n")[0]).toBe("Moved");
      for (const event of events) {
        expect(event.metadata["duplicate_uid"]).toBeUndefined();
      }
    }
  });

  test("RDATE adds to the start rather than replacing it", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:rdate@acme.example",
      "DTSTART:20260301T090000Z",
      "SUMMARY:Office hours",
      "RDATE:20260302T090000Z",
      "END:VEVENT",
    ]);
    expect(events.map((event) => event.source_record_id)).toEqual([
      "rdate@acme.example#20260301T090000",
      "rdate@acme.example#20260302T090000",
    ]);
  });

  test("an out-of-range duration leaves the end unknown", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:huge@acme.example",
      "DTSTART:20260301T090000Z",
      "DURATION:P99999999999W",
      "SUMMARY:Huge",
      "END:VEVENT",
    ]);
    expect(events[0]?.metadata["ends_at"]).toBeNull();
    expect(events[0]?.metadata["duration"]).toBeUndefined();
    expect(validateEventInput(events[0] as CaptureEventInput).ok).toBe(true);
  });

  test("events come back sorted by source record id", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:zulu@acme.example",
      "DTSTART:20260302T090000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:alpha@acme.example",
      "DTSTART:20260302T090000Z",
      "END:VEVENT",
    ]);
    expect(events.map((event) => event.source_record_id)).toEqual([
      "alpha@acme.example",
      "zulu@acme.example",
    ]);
  });
});

describe("small helpers", () => {
  test("slugify keeps the safe characters and bounds the length", () => {
    expect(slugify("Acme Team / 2026")).toBe("acme-team---2026");
    expect(slugify("x".repeat(200))).toHaveLength(64);
  });

  test("parseDuration reads the ISO 8601 forms it supports", () => {
    expect(parseDuration("PT1H")).toBe(3_600);
    expect(parseDuration("P1DT2H30M")).toBe(95_400);
    expect(parseDuration("P2W")).toBe(1_209_600);
    expect(parseDuration("-PT15M")).toBe(-900);
    expect(parseDuration("nonsense")).toBeNull();
    expect(parseDuration("P99999999999W")).toBeNull();
    expect(parseDuration("-P4000D")).toBeNull();
  });
});

describe("one unreadable entry costs only itself", () => {
  const bad = [
    "BEGIN:VEVENT",
    "UID:one@acme.example",
    "DTSTART:20260301T100000Z",
    "SUMMARY:One",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:two@acme.example",
    "DTSTART;VALUE=DATE:20260305T000000",
    "SUMMARY:Two",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:three@acme.example",
    "DTSTART:20260307T100000Z",
    "SUMMARY:Three",
    "END:VEVENT",
  ];

  test("the neighbours of a malformed date still reach the ledger", () => {
    const result = mapAll(bad);
    expect(result.events.map((event) => event.source_record_id)).toEqual([
      "one@acme.example",
      "three@acme.example",
    ]);
    expect(result.skipped).toBe(1);
  });

  test.each([
    ["an unparsable DTSTART", ["DTSTART:not-a-date", "SUMMARY:Broken"]],
    [
      "a date-only value that carries a time",
      ["DTSTART;VALUE=DATE:20260305T000000", "SUMMARY:Broken"],
    ],
    [
      "a malformed DTEND",
      ["DTSTART:20260302T100000Z", "DTEND:20260302T9900Z", "SUMMARY:Broken"],
    ],
    [
      "one bad value inside EXDATE",
      [
        "DTSTART:20260302T100000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        "EXDATE:20260303T100000Z,nonsense",
        "SUMMARY:Broken",
      ],
    ],
    [
      "a malformed RECURRENCE-ID",
      [
        "DTSTART:20260302T100000Z",
        "SUMMARY:Broken",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:broken@acme.example",
        "RECURRENCE-ID:20260232T100000Z",
        "DTSTART:20260304T100000Z",
        "SUMMARY:Moved",
      ],
    ],
    [
      "an impossible clock time",
      ["DTSTART:20260301T100061Z", "SUMMARY:Broken"],
    ],
  ])("%s skips its own entry only", (_label, body) => {
    const result = mapAll([
      "BEGIN:VEVENT",
      "UID:keeper@acme.example",
      "DTSTART:20260301T100000Z",
      "SUMMARY:Keeper",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:broken@acme.example",
      ...body,
      "END:VEVENT",
    ]);
    expect(result.events.map((event) => event.source_record_id)).toEqual([
      "keeper@acme.example",
    ]);
    expect(result.skipped).toBe(1);
  });

  test("a readable calendar reports nothing skipped", () => {
    expect(mapAll(bad.slice(0, 6)).skipped).toBe(0);
  });
});

describe("an unstorable start costs only its own entry", () => {
  test("a year the ledger cannot hold is skipped, not emitted", () => {
    const result = mapAll([
      "BEGIN:VEVENT",
      "UID:keeper@acme.example",
      "DTSTART:20260301T100000Z",
      "SUMMARY:Keeper",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ancient@acme.example",
      "DTSTART:00000101T000000Z",
      "SUMMARY:Ancient",
      "END:VEVENT",
    ]);
    expect(result.events.map((event) => event.source_record_id)).toEqual([
      "keeper@acme.example",
    ]);
    expect(result.skipped).toBe(1);
    for (const event of result.events) {
      expect(validateEventInput(event).ok).toBe(true);
    }
  });
});

describe("hostile metadata is bounded", () => {
  const long = "x".repeat(70_000);

  test("a huge calendar name, location and url are capped", () => {
    const result = mapAll(
      [
        "BEGIN:VEVENT",
        "UID:big@acme.example",
        "DTSTART:20260301T100000Z",
        "SUMMARY:Big",
        `LOCATION:${long}`,
        `URL:https://acme.example/${long}`,
        "END:VEVENT",
      ].map((line) => line),
    );
    const event = result.events[0];
    expect((event?.metadata["location"] as string).length).toBe(
      MAX_METADATA_VALUE_CHARS,
    );
    expect((event?.metadata["url"] as string).length).toBe(
      MAX_METADATA_VALUE_CHARS,
    );
  });

  test("a huge X-WR-CALNAME is capped in every event it names", () => {
    const result = calendarEvents(
      parseIcs(
        [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          `X-WR-CALNAME:${long}`,
          "BEGIN:VEVENT",
          "UID:big@acme.example",
          "DTSTART:20260301T100000Z",
          "SUMMARY:Big",
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n"),
      ),
      {
        slugSource: "acme-team",
        observedAt: "2026-03-01T00:00:00.000Z",
        now: FIXTURE_NOW,
      },
    );
    expect(
      (result.events[0]?.metadata["calendar_name"] as string).length,
    ).toBe(MAX_METADATA_VALUE_CHARS);
  });
});

describe("the calendar subject always names something", () => {
  test("a blank calendar name falls back to the file or host label", () => {
    const events = mapped(
      [
        "X-WR-CALNAME:   ",
        "BEGIN:VEVENT",
        "UID:one@acme.example",
        "DTSTART:20260301T100000Z",
        "SUMMARY:One",
        "END:VEVENT",
      ],
      "team",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.subjects).toContainEqual({
      subject_id: "calendar:team",
      role: "about",
    });
  });

  test("an unusable name and an unusable source still name a calendar", () => {
    const events = calendarEvents(
      parseIcs(
        [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "X-WR-CALNAME:   ",
          "BEGIN:VEVENT",
          "UID:one@acme.example",
          "DTSTART:20260301T100000Z",
          "SUMMARY:One",
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n"),
      ),
      { slugSource: "   ", observedAt: "2026-03-01T00:00:00.000Z", now: FIXTURE_NOW },
    ).events;
    expect(events[0]?.subjects).toContainEqual({
      subject_id: "calendar:unnamed",
      role: "about",
    });
    expect(events[0]?.metadata).not.toHaveProperty("calendar_name");
  });
});

describe("truncation marks every instance of the series", () => {
  test("an override outside the kept window says the series was truncated", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:daily@acme.example",
      "DTSTART:20240101T090000Z",
      "RRULE:FREQ=DAILY",
      "SUMMARY:Standup",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:daily@acme.example",
      "RECURRENCE-ID:20240102T090000Z",
      "DTSTART:20240102T110000Z",
      "SUMMARY:Moved",
      "END:VEVENT",
    ]);
    const moved = events.find((event) => event.text === "Moved");
    expect(moved?.source_record_id).toBe(
      "daily@acme.example#20240102T110000",
    );
    expect(
      (moved?.metadata["recurrence"] as Record<string, unknown>)[
        "recurrence_id"
      ],
    ).toBe("20240102T090000");
    expect(
      (moved?.metadata["recurrence"] as Record<string, unknown>)["truncated"],
    ).toBe(true);
    for (const event of events) {
      expect(
        (event.metadata["recurrence"] as Record<string, unknown>)["truncated"],
      ).toBe(true);
    }
  });
});
