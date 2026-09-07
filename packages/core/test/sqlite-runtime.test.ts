import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parseSqliteRuntime, readSqliteRuntime } from "../src/internal";
import type { SqliteRuntime } from "../src/internal";

const observation: SqliteRuntime = {
  schema: "kizuki.sqlite-runtime/v1",
  bun_version: "1.2.3",
  sqlite_version: "9.8.7",
  sqlite_source_id: "synthetic unknown engine identity",
};

test("runtime observes the supplied connection and finalizes its only statement", () => {
  const db = new Database(":memory:");
  const statement = db.prepare("SELECT '9.8.7' AS sqlite_version, 'synthetic unknown engine identity' AS sqlite_source_id");
  const prepare = spyOn(db, "prepare").mockReturnValue(statement);
  try {
    expect(readSqliteRuntime(db)).toEqual({ ...observation, bun_version: Bun.version });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(() => statement.get()).toThrow();
  } finally {
    prepare.mockRestore();
    db.close(true);
  }
});

test("runtime reports the native SQLite functions without a version allowlist", () => {
  const db = new Database(":memory:");
  try {
    const statement = db.prepare<{ sqlite_version: string; sqlite_source_id: string }, []>(
      "SELECT sqlite_version() AS sqlite_version, sqlite_source_id() AS sqlite_source_id",
    );
    const expected = statement.get();
    statement.finalize();
    if (expected === null) throw new Error("native runtime row is missing");
    expect(readSqliteRuntime(db)).toEqual({ ...expected, schema: observation.schema, bun_version: Bun.version });
  } finally { db.close(true); }
});

test("missing SQL results fail with a fixed error after finalization", () => {
  const db = new Database(":memory:");
  const statement = db.prepare("SELECT 1 WHERE 0");
  const prepare = spyOn(db, "prepare").mockReturnValue(statement);
  const finalize = spyOn(statement, "finalize");
  try {
    expect(() => readSqliteRuntime(db)).toThrow(new Error("SQLite runtime observation unavailable"));
    expect(finalize).toHaveBeenCalledTimes(1);
  } finally {
    prepare.mockRestore();
    finalize.mockRestore();
    statement.finalize();
    db.close(true);
  }
});

test.each([null, "", "synthetic\ninvalid", "x".repeat(257)])(
  "malformed SQL source identity %# fails without returning its content", (sourceId) => {
    const db = new Database(":memory:");
    const statement = db.prepare("SELECT 1");
    const get = spyOn(statement, "get").mockReturnValue({ sqlite_version: observation.sqlite_version, sqlite_source_id: sourceId });
    const prepare = spyOn(db, "prepare").mockReturnValue(statement);
    try {
      expect(() => readSqliteRuntime(db)).toThrow(new Error("SQLite runtime observation unavailable"));
    } finally {
      prepare.mockRestore();
      get.mockRestore();
      statement.finalize();
      db.close(true);
    }
  },
);

test("a failed SQL query exposes only the fixed runtime error", () => {
  const db = new Database(":memory:");
  db.close(true);
  expect(() => readSqliteRuntime(db)).toThrow(new Error("SQLite runtime observation unavailable"));
});

test("the parser copies a closed bounded observation without qualifying its identity", () => {
  const parsed = parseSqliteRuntime(observation);
  expect(parsed).toEqual(observation);
  expect(parsed).not.toBe(observation);
  const boundary = { ...observation, bun_version: "b".repeat(64), sqlite_version: "v".repeat(64), sqlite_source_id: "s".repeat(256) };
  expect(parseSqliteRuntime(boundary)).toEqual(boundary);
});

test.each([
  null, [], "runtime", {},
  { ...observation, schema: "kizuki.sqlite-runtime/v2" },
  { ...observation, extra: "synthetic extra field" },
  { ...observation, sqlite_source_id: undefined },
  { ...observation, bun_version: 123 },
  { ...observation, bun_version: "b".repeat(65) },
  { ...observation, sqlite_version: "v".repeat(65) },
  { ...observation, sqlite_source_id: "s".repeat(257) },
  ...["", " ", " padded", "padded ", "line\nbreak", "tab\tvalue", "non-ascii-é"].map(
    sqlite_source_id => ({ ...observation, sqlite_source_id }),
  ),
].map(value => ({ value })))("invalid runtime shape or string %# has a fixed parser error", ({ value }) => {
  expect(() => parseSqliteRuntime(value)).toThrow(new Error("invalid SQLite runtime observation"));
});
