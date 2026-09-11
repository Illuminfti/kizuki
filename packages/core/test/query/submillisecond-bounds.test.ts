import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { instantBoundPair, instantPairSql } from "../../src/query/sql";

const BEFORE = "2026-01-01T00:00:00.123456788Z";
const MIDDLE = "2026-01-01T00:00:00.123456789Z";
const AFTER = "2026-01-01T00:00:00.123456790Z";
const OFFSET_MIDDLE = "2026-01-01T01:00:00.123456789+01:00";
const LOWERCASE = "2026-01-01t00:00:00.123456789z";

describe("sub-millisecond SQL bounds", () => {
  test("since is inclusive and until is exclusive at nanosecond precision", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id TEXT, occurred_at TEXT)");
    db.query("INSERT INTO t VALUES (?, ?), (?, ?), (?, ?)").run(
      "before",
      BEFORE,
      "middle",
      MIDDLE,
      "after",
      AFTER,
    );
    const since = db.query<{ id: string }, [number, number]>(
      `SELECT id FROM t WHERE ${instantPairSql("occurred_at")} >= (?, ?) ORDER BY id`,
    );
    const until = db.query<{ id: string }, [number, number]>(
      `SELECT id FROM t WHERE ${instantPairSql("occurred_at")} < (?, ?) ORDER BY id`,
    );
    expect(since.all(...instantBoundPair(MIDDLE, "since")).map((row) => row.id)).toEqual([
      "after",
      "middle",
    ]);
    expect(until.all(...instantBoundPair(MIDDLE, "until")).map((row) => row.id)).toEqual([
      "before",
    ]);
  });

  test("offset-equivalent and lowercase cutoffs match the UTC middle instant", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id TEXT, occurred_at TEXT)");
    db.query("INSERT INTO t VALUES (?, ?), (?, ?), (?, ?)").run(
      "before",
      BEFORE,
      "middle",
      MIDDLE,
      "after",
      AFTER,
    );
    const since = db.query<{ id: string }, [number, number]>(
      `SELECT id FROM t WHERE ${instantPairSql("occurred_at")} >= (?, ?) ORDER BY id`,
    );
    expect(since.all(...instantBoundPair(OFFSET_MIDDLE, "since")).map((row) => row.id)).toEqual([
      "after",
      "middle",
    ]);
    expect(since.all(...instantBoundPair(LOWERCASE, "since")).map((row) => row.id)).toEqual([
      "after",
      "middle",
    ]);
  });
});
