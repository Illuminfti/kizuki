import { describe, expect, test } from "bun:test";
import { normalizeTimestamp, offsetSeconds } from "../src/time";

describe("normalizeTimestamp", () => {
  test("normalizes current RFC3339 values to UTC milliseconds", () => {
    expect(normalizeTimestamp("2026-01-15T10:30:00+00:00")).toBe(
      "2026-01-15T10:30:00.000Z",
    );
    expect(normalizeTimestamp("2026-01-15T10:30:00.123456+00:00")).toBe(
      "2026-01-15T10:30:00.123Z",
    );
    expect(normalizeTimestamp("2026-01-15T05:30:00-05:00")).toBe(
      "2026-01-15T10:30:00.000Z",
    );
    expect(normalizeTimestamp("2026-01-15t10:30:00z")).toBe(
      "2026-01-15T10:30:00.000Z",
    );
  });

  test("normalizes legacy sqlx timestamps with seconds", () => {
    expect(normalizeTimestamp("2026-01-15 10:30:00")).toBe(
      "2026-01-15T10:30:00.000Z",
    );
    expect(normalizeTimestamp("2026-01-15 10:30:00.5Z")).toBe(
      "2026-01-15T10:30:00.500Z",
    );
    expect(normalizeTimestamp("2026-01-15 10:30:00.123456+02:00")).toBe(
      "2026-01-15T08:30:00.123Z",
    );
  });

  test("normalizes legacy minute precision timestamps", () => {
    expect(normalizeTimestamp("2026-01-15 10:30")).toBe(
      "2026-01-15T10:30:00.000Z",
    );
    expect(normalizeTimestamp("2026-01-15 10:30-05:00")).toBe(
      "2026-01-15T15:30:00.000Z",
    );
  });

  test("rejects garbage, bare dates and month 13", () => {
    for (const value of [
      "yesterday",
      "2026-01-15",
      "2026-13-15 10:30:00",
      "2026-01-15 25:30:00",
      1_768_473_000,
      null,
    ]) {
      expect(normalizeTimestamp(value)).toBeNull();
    }
  });
});

describe("offsetSeconds", () => {
  test("adds a finite non-negative offset below one day", () => {
    expect(offsetSeconds("2026-01-15T10:30:00.000Z", 12.5)).toBe(
      "2026-01-15T10:30:12.500Z",
    );
  });

  test("ignores negative, non-finite and out-of-range offsets", () => {
    const base = "2026-01-15T10:30:00.000Z";
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 86_400]) {
      expect(offsetSeconds(base, value)).toBe(base);
    }
    expect(offsetSeconds(base, "12")).toBe(base);
    expect(offsetSeconds(base, null)).toBe(base);
  });
});
