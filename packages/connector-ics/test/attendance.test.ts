import { describe, expect, test } from "bun:test";
import type { CaptureEventInput } from "@kizuki/core";
import { calendarEvents } from "../src/events";
import { parseIcs } from "../src/parse";
import { FIXTURE_NOW } from "../src/fixture";

/**
 * A calendar entry is a plan, not a record of what happened. Whatever an
 * invitation says about who accepted, declined, or was asked to answer, the
 * event stores the people as addressed subjects and nothing more: attendance
 * is never inferred from a scheduled event.
 */

function mapped(body: string[]): CaptureEventInput[] {
  return calendarEvents(
    parseIcs(
      ["BEGIN:VCALENDAR", "VERSION:2.0", ...body, "END:VCALENDAR", ""].join(
        "\r\n",
      ),
    ),
    {
      slugSource: "acme-team",
      observedAt: "2026-03-01T00:00:00.000Z",
      now: FIXTURE_NOW,
    },
  ).events;
}

const INVITE = [
  "BEGIN:VEVENT",
  "UID:invite@acme.example",
  "DTSTAMP:20260201T000000Z",
  "DTSTART:20260305T160000Z",
  "DTEND:20260305T170000Z",
  "SUMMARY:Planning workshop",
  "ORGANIZER;CN=Ada:mailto:ada@acme.example",
  "ATTENDEE;CN=Grace;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:grace@acme.example",
  "ATTENDEE;CN=Linus;PARTSTAT=DECLINED:mailto:linus@example.org",
  "ATTENDEE;CN=Team;PARTSTAT=NEEDS-ACTION;ROLE=OPT-PARTICIPANT:mailto:team@acme.example",
  "END:VEVENT",
];

describe("attendance is never inferred from a scheduled event", () => {
  test("accepted, declined and unanswered attendees are all addressed alike", () => {
    const [event] = mapped(INVITE);
    expect(event?.subjects).toEqual([
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
      {
        subject_id: "email:team@acme.example",
        role: "to",
        display_name: "Team",
      },
      { subject_id: "calendar:acme-team", role: "about" },
    ]);
  });

  test("no participation status, RSVP flag or role reaches the event", () => {
    const [event] = mapped(INVITE);
    expect(event).toBeDefined();
    const serialized = JSON.stringify(event);
    for (const marker of [
      "PARTSTAT",
      "partstat",
      "ACCEPTED",
      "DECLINED",
      "NEEDS-ACTION",
      "RSVP",
      "OPT-PARTICIPANT",
      "attended",
      "attendance",
    ]) {
      expect(serialized).not.toContain(marker);
    }
  });

  test("a declined invitation is the same record as an accepted one", () => {
    const accepted = mapped(
      INVITE.map((line) =>
        line.replace("PARTSTAT=DECLINED", "PARTSTAT=ACCEPTED"),
      ),
    );
    const declined = mapped(INVITE);
    expect(declined).toEqual(accepted);
  });

  test("a past event is still a plan: occurred_at is its scheduled start", () => {
    const [event] = mapped(INVITE);
    expect(event?.kind).toBe("calendar_event");
    expect(event?.occurred_at).toBe("2026-03-05T16:00:00.000Z");
    expect(event?.metadata["status"]).toBeNull();
  });

  test("an event the owner was never invited to still has no owner subject", () => {
    const [event] = mapped(INVITE);
    expect(
      event?.subjects.some((subject) => subject.subject_id.endsWith(":self")),
    ).toBe(false);
  });
});

describe("cancellation is the only status that changes what is stored", () => {
  test("a cancelled entry is withheld while a tentative or confirmed one is kept", () => {
    const withStatus = (uid: string, status: string) => [
      "BEGIN:VEVENT",
      `UID:${uid}@acme.example`,
      "DTSTAMP:20260201T000000Z",
      "DTSTART:20260305T160000Z",
      "SUMMARY:Status check",
      `STATUS:${status}`,
      "END:VEVENT",
    ];
    const events = mapped([
      ...withStatus("tentative", "TENTATIVE"),
      ...withStatus("confirmed", "CONFIRMED"),
      ...withStatus("cancelled", "CANCELLED"),
      ...withStatus("mixed-case", "cancelled"),
    ]);
    expect(
      events.map((event) => [event.source_record_id, event.metadata["status"]]),
    ).toEqual([
      ["confirmed@acme.example", "CONFIRMED"],
      ["tentative@acme.example", "TENTATIVE"],
    ]);
  });

  test("a cancelled instance drops only itself from an expanded series", () => {
    const events = mapped([
      "BEGIN:VEVENT",
      "UID:weekly@acme.example",
      "DTSTAMP:20260201T000000Z",
      "DTSTART:20260302T140000Z",
      "DTEND:20260302T143000Z",
      "RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=MO",
      "SUMMARY:Weekly sync",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:weekly@acme.example",
      "DTSTAMP:20260201T000000Z",
      "RECURRENCE-ID:20260309T140000Z",
      "DTSTART:20260309T140000Z",
      "DTEND:20260309T143000Z",
      "STATUS:CANCELLED",
      "SUMMARY:Weekly sync",
      "END:VEVENT",
    ]);
    expect(events.map((event) => event.occurred_at)).toEqual([
      "2026-03-02T14:00:00.000Z",
      "2026-03-16T14:00:00.000Z",
    ]);
  });
});
