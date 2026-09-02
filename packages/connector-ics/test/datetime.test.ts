import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import {
  intlZones,
  parseDateTime,
  toUtc,
  vtimezoneFixedOffset,
} from "../src/datetime";
import type { ZoneInfo } from "../src/parse";

const NO_ZONES = new Map<string, ZoneInfo>();

const fileZone = (
  tzid: string,
  standardOffsetMinutes: number | null,
): Map<string, ZoneInfo> =>
  new Map([
    [tzid, { tzid, standardOffsetMinutes, daylightOffsetMinutes: null }],
  ]);

describe("date-time parsing", () => {
  test("reads all four instant forms", () => {
    expect(parseDateTime("20260302T090000Z", {})).toEqual({
      kind: "utc",
      iso: "2026-03-02T09:00:00.000Z",
    });
    expect(parseDateTime("20260315", { VALUE: "DATE" })).toEqual({
      kind: "date",
      date: "20260315",
    });
    expect(parseDateTime("20260302T090000", {})).toEqual({
      kind: "floating",
      local: "20260302T090000",
    });
    expect(parseDateTime("20260302T090000", { TZID: "Europe/Berlin" })).toEqual(
      {
        kind: "zoned",
        local: "20260302T090000",
        tzid: "Europe/Berlin",
      },
    );
  });

  test("treats a bare date as a DATE value even without the parameter", () => {
    expect(parseDateTime("20260315", {})).toEqual({
      kind: "date",
      date: "20260315",
    });
  });

  test("refuses malformed values", () => {
    for (const value of ["", "2026-03-02", "20260302T0900", "notadate"]) {
      expect(() => parseDateTime(value, {})).toThrow(KizukiError);
    }
  });

  test("refuses a well-formed value naming a day that does not exist", () => {
    for (const value of [
      "20261399",
      "20260230",
      "20260231T090000Z",
      "20250229",
      "20260000",
      "20261301T250000Z",
      "20260302T096000Z",
    ]) {
      expect(() => parseDateTime(value, {})).toThrow(KizukiError);
    }
    expect(parseDateTime("20240229", {})).toEqual({
      kind: "date",
      date: "20240229",
    });
    expect(parseDateTime("20261231T235960Z", {})).toEqual({
      kind: "utc",
      iso: "2027-01-01T00:00:00.000Z",
    });
  });

  test("a year below 100 stays in its own century", () => {
    expect(parseDateTime("00260302T090000Z", {})).toEqual({
      kind: "utc",
      iso: "0026-03-02T09:00:00.000Z",
    });
  });
});

describe("zone resolution", () => {
  test("keeps civil time across a DST transition in Berlin", () => {
    const winter = toUtc(
      { kind: "zoned", local: "20260115T100000", tzid: "Europe/Berlin" },
      intlZones,
      NO_ZONES,
    );
    const summer = toUtc(
      { kind: "zoned", local: "20260715T100000", tzid: "Europe/Berlin" },
      intlZones,
      NO_ZONES,
    );
    expect(winter).toEqual({
      iso: "2026-01-15T09:00:00.000Z",
      approximation: "none",
    });
    expect(summer).toEqual({
      iso: "2026-07-15T08:00:00.000Z",
      approximation: "none",
    });
  });

  test("handles half-hour and quarter-hour offsets", () => {
    expect(
      toUtc(
        { kind: "zoned", local: "20260302T120000", tzid: "Asia/Kolkata" },
        intlZones,
        NO_ZONES,
      ).iso,
    ).toBe("2026-03-02T06:30:00.000Z");
    expect(
      toUtc(
        { kind: "zoned", local: "20260302T120000", tzid: "Asia/Kathmandu" },
        intlZones,
        NO_ZONES,
      ).iso,
    ).toBe("2026-03-02T06:15:00.000Z");
  });

  test("resolves a local time inside a spring-forward gap deterministically", () => {
    const gap = toUtc(
      { kind: "zoned", local: "20260329T023000", tzid: "Europe/Berlin" },
      intlZones,
      NO_ZONES,
    );
    // 02:30 local does not exist on this date; the two-pass resolution lands
    // just past the gap rather than failing or picking an arbitrary offset.
    expect(gap.approximation).toBe("none");
    expect(gap.iso).toBe("2026-03-29T01:30:00.000Z");
  });

  test("falls back to the file's VTIMEZONE for a zone the platform lacks", () => {
    const result = toUtc(
      { kind: "zoned", local: "20260309T093000", tzid: "Acme Standard Time" },
      intlZones,
      fileZone("Acme Standard Time", -300),
    );
    expect(result).toEqual({
      iso: "2026-03-09T14:30:00.000Z",
      approximation: "vtimezone-fixed-offset",
    });
  });

  test("says unresolved rather than guessing an offset", () => {
    expect(
      toUtc(
        { kind: "zoned", local: "20260309T093000", tzid: "Nowhere/Nothing" },
        intlZones,
        NO_ZONES,
      ),
    ).toEqual({
      iso: "2026-03-09T09:30:00.000Z",
      approximation: "unresolved",
    });
  });

  test("floating and date values are labelled honestly", () => {
    expect(
      toUtc(
        { kind: "floating", local: "20260302T090000" },
        intlZones,
        NO_ZONES,
      ),
    ).toEqual({ iso: "2026-03-02T09:00:00.000Z", approximation: "floating" });
    expect(
      toUtc({ kind: "date", date: "20260315" }, intlZones, NO_ZONES),
    ).toEqual({
      iso: "2026-03-15T00:00:00.000Z",
      approximation: "none",
    });
  });

  test("the resolver reports null for an id it does not know", () => {
    expect(intlZones.offsetMinutes("Nowhere/Nothing", Date.now())).toBeNull();
    expect(
      intlZones.offsetMinutes("UTC", Date.parse("2026-03-02T00:00:00Z")),
    ).toBe(0);
    expect(vtimezoneFixedOffset(undefined)).toBeNull();
  });
});
