import { describe, expect, test } from "bun:test";
import { parseArchiveDate } from "../src";

describe("X archive provider timestamps", () => {
  test("preserves a valid provider offset as an exact instant", () => {
    expect(parseArchiveDate("Tue Jan 02 08:34:05 +0530 2024"))
      .toBe("2024-01-02T03:04:05.000Z");
  });

  test.each([
    "Mon Jan 02 03:04:05 +0000 2024",
    "Tue Feb 30 03:04:05 +0000 2024",
    "Tue Jan 02 03:04:05 UTC 2024",
    "Tue Jan 02 03:04:05 -0000 2024",
    "Tue Jan 02 03:04:05 +1401 2024",
    "Tue Jan 02 24:04:05 +0000 2024",
  ])("refuses rollover or unknown timestamp %s", (value) => {
    expect(() => parseArchiveDate(value)).toThrow("created_at");
  });
});
