import { describe, expect, test } from "bun:test";
import { isRfc3339 } from "../src/util/time";

describe("isRfc3339", () => {
  const valid = [
    "2026-01-01T00:00:00Z",
    "2026-12-31T23:59:59Z",
    "2024-02-29T12:00:00Z",
    "2000-02-29T12:00:00Z",
    "2026-06-30T23:59:60Z",
    "2026-01-02T03:04:05.1Z",
    "2026-01-02T03:04:05.123456789+14:00",
    "2026-01-02T03:04:05-00:00",
    "2026-01-02t03:04:05z",
  ];
  for (const s of valid) {
    test(`accepts ${s}`, () => expect(isRfc3339(s)).toBe(true));
  }

  const invalid: [string, unknown][] = [
    ["a non-string", 0],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a bare date", "2026-01-02"],
    ["a space separator", "2026-01-02 03:04:05Z"],
    ["no offset", "2026-01-02T03:04:05"],
    ["a two-digit year", "26-01-02T03:04:05Z"],
    ["month 13", "2026-13-02T03:04:05Z"],
    ["day 00", "2026-01-00T03:04:05Z"],
    ["Feb 29 in 1900", "1900-02-29T00:00:00Z"],
    ["Feb 29 in 2100", "2100-02-29T00:00:00Z"],
    ["Sep 31", "2026-09-31T00:00:00Z"],
    ["hour 24", "2026-01-02T24:04:05Z"],
    ["second 61", "2026-01-02T03:04:61Z"],
    ["offset hour 24", "2026-01-02T03:04:05+24:00"],
    ["offset minute 60", "2026-01-02T03:04:05+00:60"],
    ["an empty fraction", "2026-01-02T03:04:05.Z"],
    ["trailing text", "2026-01-02T03:04:05Z "],
    ["year 0000", "0000-01-02T03:04:05Z"],
  ];
  for (const [name, s] of invalid) {
    test(`rejects ${name}`, () => expect(isRfc3339(s)).toBe(false));
  }

  test("is stricter than Date.parse", () => {
    // Date.parse happily rolls this over into March.
    expect(Number.isNaN(Date.parse("2026-02-30T00:00:00Z"))).toBe(false);
    expect(isRfc3339("2026-02-30T00:00:00Z")).toBe(false);
  });
});
