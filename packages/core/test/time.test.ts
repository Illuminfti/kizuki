import { describe, expect, test } from "bun:test";
import { canonicalizeRfc3339Utc, isRfc3339 } from "../src/util/time";

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
    ["a leap second outside minute 59", "2026-01-02T03:04:60Z"],
    ["offset hour 24", "2026-01-02T03:04:05+24:00"],
    ["offset minute 60", "2026-01-02T03:04:05+00:60"],
    ["an empty fraction", "2026-01-02T03:04:05.Z"],
    ["ten fractional digits", "2026-01-02T03:04:05.1234567890Z"],
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

describe("canonicalizeRfc3339Utc", () => {
  test("maps offset-equivalent instants to one UTC spelling", () => {
    const a = canonicalizeRfc3339Utc("2026-01-02T03:04:05+01:00");
    const b = canonicalizeRfc3339Utc("2026-01-02T02:04:05Z");
    expect(a).toBe("2026-01-02T02:04:05.000000000Z");
    expect(b).toBe(a);
  });

  test("pads fractional seconds to nine digits", () => {
    expect(canonicalizeRfc3339Utc("2026-01-02T03:04:05.1Z")).toBe(
      "2026-01-02T03:04:05.100000000Z",
    );
  });

  test("rejects invalid input", () => {
    expect(canonicalizeRfc3339Utc("2026-02-30T00:00:00Z")).toBeNull();
    expect(canonicalizeRfc3339Utc("not-a-time")).toBeNull();
  });

  test("every canonical form is itself accepted by isRfc3339", () => {
    for (const s of [
      "2026-01-02T03:04:05+01:00",
      "2026-06-30T23:59:60Z",
      "0001-01-01T00:00:00Z",
      "9999-12-31T23:59:59Z",
    ]) {
      const canonical = canonicalizeRfc3339Utc(s);
      expect(canonical).not.toBeNull();
      expect(isRfc3339(canonical!)).toBe(true);
    }
  });

  test("rejects instants whose UTC form leaves years 0001-9999", () => {
    // Valid RFC3339 input, but shifting the offset away has no RFC3339
    // spelling, so canonicalize refuses rather than emitting year 10000/0000.
    expect(canonicalizeRfc3339Utc("9999-12-31T23:59:59-14:00")).toBeNull();
    expect(canonicalizeRfc3339Utc("0001-01-01T00:00:00+14:00")).toBeNull();
  });

  test("offset-equivalent forms compare equal as strings after canonicalize", () => {
    const left = canonicalizeRfc3339Utc("2026-06-01T12:00:00-05:00");
    const right = canonicalizeRfc3339Utc("2026-06-01T17:00:00Z");
    expect(left).toBe(right);
    expect(left! < "2026-06-01T17:00:00.000000001Z").toBe(true);
  });
});
