import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../../src/agents/types";
import { rfc3339Instant } from "../../src/agents/time";
import {
  ceilingSql,
  instantBound,
  instantBoundPair,
  instantNanoSql,
  instantSecondSql,
} from "../../src/query/sql";

const CONTRACT_INSTANTS = [
  "2026-02-02T23:30:00-02:00",
  "2026-02-03t02:00:00z",
  "2026-06-30T23:59:60Z",
  "2026-06-30T23:59:60.9Z",
  "2026-06-30T23:59:60+05:30",
  "2026-01-01T00:00:00.123456Z",
  "2026-12-31T23:59:59-00:00",
  "2026-01-01T00:00:00.123456789+14:00",
  "2026-01-01T00:00:00.123456789+14:01",
  "2026-01-01T00:00:00.123456789-14:01",
  "2026-01-01T00:00:00.123456789+23:59",
  "2026-01-01T00:00:00.123456789-23:59",
  // Cover the accepted year edges, including UTC rollover beyond year 9999.
  "0001-01-01t00:00:00.000000001+23:59",
  "9999-12-31T23:59:59.999999999-23:59",
  "2026-06-30t23:59:60.1+23:59",
  "2026-06-30T23:59:60.1-23:59",
] as const;

describe("instant helpers", () => {
  test("instantBoundPair and column SQL agree on every contract-valid form", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    const insert = db.query<never, [string]>("INSERT INTO t (v) VALUES (?)");
    const column = db.query<{ seconds: number | null; nanos: number | null }, []>(
      `SELECT ${instantSecondSql("t.v")} AS seconds, ${instantNanoSql("t.v")} AS nanos FROM t`,
    );
    for (const value of CONTRACT_INSTANTS) {
      db.exec("DELETE FROM t");
      insert.run(value);
      const [seconds, nanos] = instantBoundPair(value, "instant");
      const row = column.get();
      expect(row?.seconds).toBe(seconds);
      expect(row?.nanos).toBe(nanos);
      const parsed = rfc3339Instant(value, "instant");
      expect(row?.seconds).toBe(parsed.epochSecond);
      expect(row?.nanos).toBe(parsed.nanos);
    }
  });

  test("equivalent wide offsets retain nanosecond ordering before the Unix epoch", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE t (id TEXT, v TEXT)");
      const insert = db.query<never, [string, string]>("INSERT INTO t VALUES (?, ?)");
      insert.run("later", "1970-01-01T23:58:59.000000002+23:59");
      insert.run("earlier", "1969-12-31T00:00:59.000000001-23:59");
      insert.run("equal", "1969-12-31T23:59:59.000000001Z");
      const rows = db.query<{ id: string; seconds: number; nanos: number }, []>(
        `SELECT id, ${instantSecondSql("v")} AS seconds, ${instantNanoSql("v")} AS nanos
         FROM t ORDER BY seconds, nanos, id`,
      ).all();
      expect(rows).toEqual([
        { id: "earlier", seconds: -1, nanos: 1 },
        { id: "equal", seconds: -1, nanos: 1 },
        { id: "later", seconds: -1, nanos: 2 },
      ]);
    } finally {
      db.close();
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
