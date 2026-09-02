import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import { MAX_CONTENT_LINES, unfold } from "../src/unfold";
import {
  MAX_COMPONENTS,
  allValues,
  firstValue,
  parseContentLine,
  parseIcs,
  unescapeText,
} from "../src/parse";

const calendar = (body: string[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...body, "END:VCALENDAR", ""].join("\r\n");

describe("unfolding", () => {
  test("joins continuation lines folded with a space or a tab", () => {
    expect(unfold("DESCRIPTION:one\r\n two\r\nSUMMARY:x\r\n\ty")).toEqual([
      "DESCRIPTION:onetwo",
      "SUMMARY:xy",
    ]);
  });

  test("accepts bare LF and strips a UTF-8 BOM", () => {
    expect(unfold("﻿BEGIN:VCALENDAR\nEND:VCALENDAR")).toEqual([
      "BEGIN:VCALENDAR",
      "END:VCALENDAR",
    ]);
  });

  test("refuses a calendar with too many content lines", () => {
    const many = Array.from(
      { length: MAX_CONTENT_LINES + 5 },
      () => "X-FILLER:v",
    ).join("\r\n");
    expect(() => unfold(many)).toThrow(KizukiError);
  });

  test("refuses text past the size bound", () => {
    expect(() => unfold("x".repeat(9 * 1024 * 1024))).toThrow(/too long/);
  });
});

describe("content lines", () => {
  test("splits the name, parameters and value", () => {
    expect(
      parseContentLine("DTSTART;TZID=Europe/Berlin:20260703T100000"),
    ).toEqual({
      name: "DTSTART",
      params: { TZID: ["Europe/Berlin"] },
      value: "20260703T100000",
    });
  });

  test("keeps a colon inside a quoted parameter out of the split", () => {
    const line = parseContentLine(
      'ATTACH;FMTTYPE="text/plain;x=1":https://a.example/x',
    );
    expect(line?.name).toBe("ATTACH");
    expect(line?.params["FMTTYPE"]).toEqual(["text/plain;x=1"]);
    expect(line?.value).toBe("https://a.example/x");
  });

  test("reads multi-value parameters and folds case", () => {
    const line = parseContentLine(
      "attendee;role=REQ-PARTICIPANT;member=a,b:mailto:x@acme.example",
    );
    expect(line?.name).toBe("ATTENDEE");
    expect(line?.params["MEMBER"]).toEqual(["a", "b"]);
  });

  test("rejects a line with no value separator", () => {
    expect(parseContentLine("NOCOLON")).toBeNull();
    expect(parseContentLine(":novalue")).toBeNull();
  });

  test("unescapes RFC 5545 text", () => {
    expect(unescapeText("a\\nb\\Nc\\,d\\;e\\\\f")).toBe("a\nb\nc,d;e\\f");
  });
});

describe("component walk", () => {
  test("reads the calendar header, zones and events", () => {
    const parsed = parseIcs(
      calendar([
        "PRODID:-//Acme//test//EN",
        "X-WR-CALNAME:Acme team",
        "METHOD:PUBLISH",
        "BEGIN:VTIMEZONE",
        "TZID:Acme Standard Time",
        "BEGIN:STANDARD",
        "TZOFFSETTO:-0500",
        "END:STANDARD",
        "BEGIN:DAYLIGHT",
        "TZOFFSETTO:-0400",
        "END:DAYLIGHT",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "UID:a@acme.example",
        "DTSTART:20260302T090000Z",
        "ATTENDEE:mailto:grace@acme.example",
        "ATTENDEE:mailto:linus@example.org",
        "END:VEVENT",
      ]),
    );
    expect(parsed.calendar).toEqual({
      name: "Acme team",
      prodid: "-//Acme//test//EN",
      method: "PUBLISH",
    });
    expect(parsed.zones.get("Acme Standard Time")).toEqual({
      tzid: "Acme Standard Time",
      standardOffsetMinutes: -300,
      daylightOffsetMinutes: -240,
    });
    expect(parsed.events).toHaveLength(1);
    const event = parsed.events[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(firstValue(event, "UID")?.value).toBe("a@acme.example");
    expect(allValues(event, "ATTENDEE")).toHaveLength(2);
  });

  test("skips components that are not calendar events", () => {
    const parsed = parseIcs(
      calendar([
        "BEGIN:VTODO",
        "UID:todo@acme.example",
        "END:VTODO",
        "BEGIN:VJOURNAL",
        "UID:journal@acme.example",
        "END:VJOURNAL",
        "BEGIN:VFREEBUSY",
        "UID:busy@acme.example",
        "END:VFREEBUSY",
        "BEGIN:VEVENT",
        "UID:real@acme.example",
        "DTSTART:20260302T090000Z",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "END:VALARM",
        "END:VEVENT",
      ]),
    );
    expect(parsed.events).toHaveLength(1);
    expect(firstValue(parsed.events[0] ?? { lines: [] }, "UID")?.value).toBe(
      "real@acme.example",
    );
  });

  test("refuses a document with no VCALENDAR", () => {
    expect(() => parseIcs("BEGIN:VEVENT\r\nEND:VEVENT\r\n")).toThrow(
      /no VCALENDAR/,
    );
  });

  test("refuses too many components", () => {
    const body = Array.from(
      { length: MAX_COMPONENTS + 5 },
      () => "BEGIN:VEVENT\r\nEND:VEVENT",
    );
    expect(() => parseIcs(calendar(body))).toThrow(/too many components/);
  });

  test("refuses components nested too deeply", () => {
    const opens = Array.from(
      { length: 10 },
      (_unused, index) => `BEGIN:X${index}`,
    );
    expect(() => parseIcs(calendar(opens))).toThrow(/nest too deeply/);
  });
});
