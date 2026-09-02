import { expect, test } from "bun:test";
import { KizukiError } from "../src/errors";
import {
  detectDateOrder,
  localToUtc,
  resolveTimezone,
} from "../src/import-whatsapp/dates";
import type { RawDate } from "../src/import-whatsapp/dates";
import { splitWhatsAppMessages } from "../src/import-whatsapp/grammar";
import type { DateOrder } from "../src/import-whatsapp/dates";

function date(a: number, b: number, c: number, wide_first = false): RawDate {
  return { a, b, c, wide_first };
}

function thrown(body: () => unknown): KizukiError {
  try {
    body();
  } catch (error) {
    if (error instanceof KizukiError) return error;
    throw error;
  }
  throw new Error("expected a KizukiError");
}

function stamps(text: string, order?: DateOrder): string[] {
  return splitWhatsAppMessages(text, order).messages.map(
    (message) => message.local_timestamp,
  );
}

test("a day field above twelve settles the order", () => {
  expect(detectDateOrder([date(13, 1, 26), date(1, 4, 26)])).toBe("dmy");
  expect(detectDateOrder([date(1, 13, 26), date(1, 4, 26)])).toBe("mdy");
});

test("a four-digit leading field settles the order", () => {
  expect(detectDateOrder([date(2026, 1, 4, true)])).toBe("ymd");
});

test("mixed wide and narrow leading fields are refused", () => {
  const error = thrown(() =>
    detectDateOrder([date(2026, 1, 4, true), date(1, 4, 26)]),
  );
  expect(error.code).toBe("parse_error");
  expect(error.message).toContain("inconsistent date formats");
});

test("evidence for both orders in one file is refused", () => {
  const error = thrown(() =>
    detectDateOrder([date(13, 1, 26), date(1, 13, 26)]),
  );
  expect(error.code).toBe("parse_error");
  expect(error.message).toContain("inconsistent dates");
});

test("without evidence the chronological hypothesis wins", () => {
  expect(detectDateOrder([date(5, 6, 26), date(4, 7, 26)])).toBe("dmy");
  expect(detectDateOrder([date(6, 5, 26), date(7, 4, 26)])).toBe("mdy");
});

test("an order that stays ambiguous is refused, never guessed", () => {
  for (const dates of [
    [date(1, 2, 26), date(3, 4, 26)],
    [date(3, 4, 26), date(1, 2, 26)],
  ]) {
    const error = thrown(() => detectDateOrder(dates));
    expect(error.code).toBe("parse_error");
    expect(error.message).toContain(
      'ambiguous date order (DD/MM vs MM/DD); set date_order to "dmy" or "mdy"',
    );
  }
});

test("a configured order skips detection entirely", () => {
  // Undetectable alone: 4/1 is a valid date under both hypotheses.
  const ambiguous = "4/1/26, 09:00 - Ada: hi";
  expect(stamps(ambiguous, "dmy")).toEqual(["2026-01-04T09:00"]);
  expect(stamps(ambiguous, "mdy")).toEqual(["2026-04-01T09:00"]);
  expect(thrown(() => stamps(ambiguous)).code).toBe("parse_error");
});

test("a date invalid under the configured order names its line", () => {
  for (const line of [
    "31/04/2026, 09:00 - Ada: hi",
    "29/02/2027, 09:00 - Ada: hi",
  ]) {
    const error = thrown(() => stamps(`x\n${line}`, "dmy"));
    expect(error.code).toBe("parse_error");
    expect(error.message).toContain("line 2");
    expect(error.message).not.toContain("Ada");
  }
});

test("twelve-hour clocks resolve to a twenty-four hour stamp", () => {
  expect(
    stamps(
      [
        "4/1/26, 12:00 AM - Ada: a",
        "4/1/26, 12:30 PM - Ada: b",
        "4/1/26, 6:05 PM - Ada: c",
        "4/1/26, 9:15 a.m. - Ada: d",
        "4/1/26, 10:15 p. m. - Ada: e",
        "4/1/26, 11:15\u00A0pm - Ada: f",
        "4/1/26, 11:45\u202FPM - Ada: g",
      ].join("\n"),
      "dmy",
    ),
  ).toEqual([
    "2026-01-04T00:00",
    "2026-01-04T12:30",
    "2026-01-04T18:05",
    "2026-01-04T09:15",
    "2026-01-04T22:15",
    "2026-01-04T23:15",
    "2026-01-04T23:45",
  ]);
});

test("an hour above twelve with a meridiem is refused", () => {
  const error = thrown(() => stamps("4/1/26, 13:00 PM - Ada: hi", "dmy"));
  expect(error.code).toBe("parse_error");
  expect(error.message).toContain("line 1");
});

test("two-digit and four-digit years both resolve", () => {
  expect(
    stamps("4/1/26, 09:00 - Ada: a\n5/1/2026, 09:00:30 - Ada: b", "dmy"),
  ).toEqual(["2026-01-04T09:00", "2026-01-05T09:00:30"]);
});

test("resolveTimezone accepts the host zone and fixed offsets", () => {
  expect(resolveTimezone(undefined)).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  expect(resolveTimezone("+02:00")).toBe("+02:00");
  expect(resolveTimezone("Europe/Berlin")).toBe("Europe/Berlin");
});

test("resolveTimezone refuses an impossible or unknown zone", () => {
  for (const value of ["+15:00", "-00:99", "Not/AZone", ""]) {
    expect(thrown(() => resolveTimezone(value)).code).toBe("misconfigured");
  }
});

test("a fixed offset is plain arithmetic", () => {
  expect(localToUtc("2026-01-04T09:15", "+00:00")).toBe(
    "2026-01-04T09:15:00.000Z",
  );
  expect(localToUtc("2026-01-13T18:05", "+02:00")).toBe(
    "2026-01-13T16:05:00.000Z",
  );
  expect(localToUtc("2026-01-13T18:05:30", "-05:30")).toBe(
    "2026-01-13T23:35:30.000Z",
  );
});

test("a named zone follows its own summer and winter offsets", () => {
  expect(localToUtc("2026-07-01T10:00", "Europe/Berlin")).toBe(
    "2026-07-01T08:00:00.000Z",
  );
  expect(localToUtc("2026-01-01T10:00", "Europe/Berlin")).toBe(
    "2026-01-01T09:00:00.000Z",
  );
  expect(localToUtc("2026-07-01T10:00", "America/New_York")).toBe(
    "2026-07-01T14:00:00.000Z",
  );
});

test("a repeated wall-clock hour takes the earlier instant", () => {
  expect(localToUtc("2026-10-25T02:30", "Europe/Berlin")).toBe(
    "2026-10-25T00:30:00.000Z",
  );
});

test("a wall-clock hour that never happened shifts forward by the gap", () => {
  expect(localToUtc("2026-03-29T02:30", "Europe/Berlin")).toBe(
    "2026-03-29T01:30:00.000Z",
  );
});

test("a zone builds its formatter once, however many lines use it", () => {
  const real = Intl.DateTimeFormat;
  let built = 0;
  Intl.DateTimeFormat = new Proxy(real, {
    construct(target, args: [string?, Intl.DateTimeFormatOptions?]) {
      built += 1;
      return Reflect.construct(target, args) as Intl.DateTimeFormat;
    },
  });
  try {
    // A zone this file uses nowhere else, so the first call is the one that
    // builds it; an export converts once per message, and rebuilding the
    // formatter each time costs more than the conversion.
    for (let line = 0; line < 200; line += 1) {
      expect(localToUtc("2026-07-01T10:00", "Asia/Tokyo")).toBe(
        "2026-07-01T01:00:00.000Z",
      );
    }
  } finally {
    Intl.DateTimeFormat = real;
  }
  expect(built).toBeLessThanOrEqual(1);
});
