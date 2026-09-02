import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../../src/agents/types";
import {
  ceilingSql,
  instantBound,
  instantParam,
  instantSql,
} from "../../src/query/sql";

const CONTRACT_INSTANTS = [
  "2026-02-02T23:30:00-02:00",
  "2026-02-03t02:00:00z",
  "2026-06-30T23:59:60Z",
  "2026-06-30T23:59:60+05:30",
  // A leap second may carry a fraction; both sides drop it for :59.999.
  "2026-06-30T23:59:60.5Z",
  "2026-06-30T23:59:60.500+05:30",
  "2026-06-30t23:59:60.250z",
  "2026-01-01T00:00:00.123456Z",
  "2026-12-31T23:59:59-00:00",
  // A fraction finer than a millisecond: a `Date` round-trip would truncate
  // it and land on the other side of the column.
  "2026-01-01T00:00:00.1235Z",
  "2026-01-01T00:00:00.9995Z",
  "2026-01-01T00:00:00.999999+05:30",
  // Offsets the contract admits and SQLite's own date parser rejects.
  "2026-02-03T12:00:00+15:00",
  "2026-02-03T12:00:00+23:59",
  "2026-02-03T12:00:00-23:59",
  "2026-06-30t23:59:60.5-18:47",
] as const;

describe("instant helpers", () => {
  test("instantBound and instantSql agree on every contract-valid form", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    const insert = db.query<never, [string]>("INSERT INTO t (v) VALUES (?)");
    const column = db.query<
      { bound: number | null; column: number | null },
      [string]
    >(
      `SELECT ${instantParam} AS bound, ${instantSql("t.v")} AS column FROM t`,
    );
    for (const value of CONTRACT_INSTANTS) {
      db.exec("DELETE FROM t");
      insert.run(value);
      const row = column.get(instantBound(value, "instant"));
      expect(row?.bound).not.toBeNull();
      expect(row?.column).not.toBeNull();
      expect(row?.bound).toBe(row?.column);
    }
  });

  test("instantSql resolves an out-of-range offset to its real UTC instant", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    db.query<never, [string]>("INSERT INTO t (v) VALUES (?)").run(
      "2026-02-03T12:00:00+15:00",
    );
    const row = db
      .query<{ column: number | null; utc: number | null }, [string]>(
        `SELECT ${instantSql("t.v")} AS column, julianday(?) AS utc FROM t`,
      )
      .get("2026-02-02T21:00:00Z");
    expect(row?.column).not.toBeNull();
    expect(row?.column).toBe(row?.utc);
  });

  test("instantBound rejects non-RFC3339 input with RangeError", () => {
    expect(() => instantBound("garbage", "since")).toThrow(RangeError);
    expect(() => instantBound("2026-02-30T00:00:00Z", "since")).toThrow(
      RangeError,
    );
    expect(() => instantBound("", "since")).toThrow(RangeError);
  });
});

describe("ceilingSql", () => {
  test("ranks the lattice from SENSITIVITY_ORDER and excludes unlabeled", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (sensitivity TEXT)");
    db.exec(`
      INSERT INTO t VALUES ('public'), ('personal'), ('private'), (NULL), ('unlabeled')
    `);
    const allowed = db.query<{ sensitivity: string | null }, [number]>(
      `SELECT sensitivity FROM t WHERE ${ceilingSql("sensitivity")} ORDER BY sensitivity`,
    );
    expect(
      allowed
        .all(SENSITIVITY_ORDER.personal)
        .map(({ sensitivity }) => sensitivity),
    ).toEqual(["personal", "public"]);
    expect(
      allowed
        .all(SENSITIVITY_ORDER.public)
        .map(({ sensitivity }) => sensitivity),
    ).toEqual(["public"]);
  });
});
