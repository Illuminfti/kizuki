import { describe, expect, test } from "bun:test";
import {
  localToUtc,
  normalizeTimestamp,
  offsetSeconds,
  parseTimestamp,
  resolveTimestamp,
} from "../src/time";

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

  test("normalizes legacy sqlx timestamps that already carry an offset", () => {
    expect(normalizeTimestamp("2026-01-15 10:30:00.5Z")).toBe(
      "2026-01-15T10:30:00.500Z",
    );
    expect(normalizeTimestamp("2026-01-15 10:30:00.123456+02:00")).toBe(
      "2026-01-15T08:30:00.123Z",
    );
    expect(normalizeTimestamp("2026-01-15 10:30-05:00")).toBe(
      "2026-01-15T15:30:00.000Z",
    );
  });

  test("does not assign UTC to timezone-less timestamps", () => {
    expect(parseTimestamp("2026-01-15 10:30:00")).toEqual({
      kind: "offset_unknown",
      local: "2026-01-15T10:30:00",
    });
    expect(parseTimestamp("2026-01-15 10:30")).toEqual({
      kind: "offset_unknown",
      local: "2026-01-15T10:30:00",
    });
    expect(parseTimestamp("2026-01-15T10:30:00-00:00")).toEqual({
      kind: "offset_unknown",
      local: "2026-01-15T10:30:00",
    });
    expect(normalizeTimestamp("2026-01-15 10:30:00")).toBeNull();
    expect(resolveTimestamp("2026-01-15 10:30:00", null)).toEqual({
      reject: "offset_unknown",
    });
  });

  test("interprets timezone-less timestamps only with an explicit zone", () => {
    expect(normalizeTimestamp("2026-01-15 10:30:00", "-05:00")).toBe(
      "2026-01-15T15:30:00.000Z",
    );
    expect(normalizeTimestamp("2026-01-15 10:30:00", "America/New_York")).toBe(
      "2026-01-15T15:30:00.000Z",
    );
  });

  test("DST spring-forward uses the documented gap rule", () => {
    expect(localToUtc("2026-03-08T02:30:00", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(localToUtc("2026-03-08T01:30:00", "America/New_York")).toBe(
      "2026-03-08T06:30:00.000Z",
    );
    expect(localToUtc("2026-11-01T01:30:00", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
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
      expect(parseTimestamp(value)).toEqual({ kind: "unparseable" });
    }
  });
});

describe("offsetSeconds", () => {
  test("adds a finite non-negative offset below one day", () => {
    expect(offsetSeconds("2026-01-15T10:30:00.000Z", 12.5)).toBe(
      "2026-01-15T10:30:12.500Z",
    );
  });

  test("treats a missing offset as the base timestamp", () => {
    expect(offsetSeconds("2026-01-15T10:30:00.000Z", null)).toBe(
      "2026-01-15T10:30:00.000Z",
    );
    expect(offsetSeconds("2026-01-15T10:30:00.000Z", undefined)).toBe(
      "2026-01-15T10:30:00.000Z",
    );
  });

  test("refuses negative, non-finite and out-of-range offsets", () => {
    const base = "2026-01-15T10:30:00.000Z";
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 86_400]) {
      expect(offsetSeconds(base, value)).toBeNull();
    }
    expect(offsetSeconds(base, "12")).toBeNull();
  });
});
