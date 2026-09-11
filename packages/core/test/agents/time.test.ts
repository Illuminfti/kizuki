import { describe, expect, test } from "bun:test";
import { compareRfc3339 } from "../../src/agents/time";
import { instantBound } from "../../src/query/sql";

describe("compareRfc3339 leap seconds", () => {
  const leap = "2016-12-31T23:59:60.9Z";
  const lastOrdinary = "2016-12-31T23:59:59.8Z";
  const next = "2017-01-01T00:00:00.1Z";

  test("a leap second sorts after its minute and before the next second", () => {
    expect(compareRfc3339(lastOrdinary, "ordinary", leap, "leap")).toBe(-1);
    expect(compareRfc3339(leap, "leap", next, "next")).toBe(-1);
  });

  test("grant leap-second order matches SQL instantBound", () => {
    const leapZ = "2016-12-31T23:59:60Z";
    const nextZ = "2017-01-01T00:00:00Z";
    expect(new Date(instantBound(leapZ, "leap")).getTime()).toBeLessThan(
      new Date(instantBound(nextZ, "next")).getTime(),
    );
    expect(new Date(instantBound(leap, "leap")).getTime()).toBeLessThan(
      new Date(instantBound(next, "next")).getTime(),
    );
    expect(compareRfc3339(leapZ, "leap", nextZ, "next")).toBe(-1);
    expect(compareRfc3339(leap, "leap", next, "next")).toBe(-1);
  });
});
