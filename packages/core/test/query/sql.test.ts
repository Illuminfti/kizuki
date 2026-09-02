import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../../src/agents/types";
import { ceilingSql, instantBound, instantSql } from "../../src/query/sql";

const CONTRACT_INSTANTS = [
  "2026-02-02T23:30:00-02:00",
  "2026-02-03t02:00:00z",
  "2026-06-30T23:59:60Z",
  "2026-06-30T23:59:60+05:30",
  "2026-01-01T00:00:00.123456Z",
  "2026-12-31T23:59:59-00:00",
] as const;

describe("instant helpers", () => {
  test("instantBound and instantSql agree on every contract-valid form", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    const insert = db.query<never, [string]>("INSERT INTO t (v) VALUES (?)");
    const column = db.query<{ bound: number | null; column: number | null }, [string]>(
      `SELECT julianday(?) AS bound, ${instantSql("t.v")} AS column FROM t`,
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
      allowed.all(SENSITIVITY_ORDER.personal).map(({ sensitivity }) => sensitivity),
    ).toEqual(["personal", "public"]);
    expect(
      allowed.all(SENSITIVITY_ORDER.public).map(({ sensitivity }) => sensitivity),
    ).toEqual(["public"]);
  });
});
