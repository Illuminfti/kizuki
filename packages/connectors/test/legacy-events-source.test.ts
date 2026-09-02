import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KizukiError } from "../src/errors";
import { LEGACY_EVENTS_FIXTURE } from "../src/import-legacy-events/fixture";
import {
  MAX_LINE_BYTES,
  openJsonlSource,
  openSqliteSource,
} from "../src/import-legacy-events/source";
import type { LegacyRowSource } from "../src/import-legacy-events/source";

let root: string;

function dbAt(name: string, sql: string): string {
  const path = join(root, name);
  const db = new Database(path);
  db.exec(sql);
  db.close();
  return path;
}

function jsonlAt(name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

function drain(source: LegacyRowSource, limit: number): number[] {
  const positions: number[] = [];
  let after = 0;
  for (;;) {
    const rows = source.read(after, limit);
    if (rows.length === 0) break;
    for (const row of rows) positions.push(row.position);
    after = rows[rows.length - 1]?.position ?? after;
    if (rows.length < limit) break;
  }
  return positions;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kizuki-legacy-events-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the sqlite reader", () => {
  test("a missing table is a refusal that names it", () => {
    const path = dbAt("empty.db", "CREATE TABLE other (a TEXT);");
    expect(() => openSqliteSource(path, "events")).toThrow(
      /table not found: events/,
    );
  });

  test("a table with no rowid points at the JSONL path instead", () => {
    const path = dbAt(
      "norowid.db",
      "CREATE TABLE events (id TEXT PRIMARY KEY, body TEXT) WITHOUT ROWID;",
    );
    let message = "";
    try {
      openSqliteSource(path, "events");
    } catch (error) {
      if (!(error instanceof KizukiError)) throw error;
      message = error.message;
    }
    expect(message).toContain("table has no rowid; export it to JSONL");
  });

  test("a table that declares the rowid alias is refused, not silently NaN", () => {
    const path = dbAt(
      "shadow.db",
      "CREATE TABLE events (id TEXT, __rowid TEXT, ts INTEGER);",
    );
    let message = "";
    try {
      openSqliteSource(path, "events");
    } catch (error) {
      if (!(error instanceof KizukiError)) throw error;
      message = error.message;
    }
    // Shadowing the alias makes every position NaN, the cursor serialises the
    // position as null, and the next run cannot decode its own cursor.
    expect(message).toContain(
      "table declares the reserved column __rowid; export it to JSONL: events",
    );
  });

  test("keyset paging visits every row exactly once", () => {
    const path = join(root, "many.db");
    const db = new Database(path);
    db.exec("CREATE TABLE events (id TEXT)");
    const insert = db.query("INSERT INTO events (id) VALUES (?)");
    db.transaction(() => {
      for (let i = 0; i < 2500; i += 1) insert.run(`r${i}`);
    })();
    db.close();

    const source = openSqliteSource(path, "events");
    try {
      const positions = drain(source, 1000);
      expect(positions).toHaveLength(2500);
      expect(new Set(positions).size).toBe(2500);
      for (let i = 1; i < positions.length; i += 1) {
        expect(positions[i] as number).toBeGreaterThan(
          positions[i - 1] as number,
        );
      }
      expect(source.size()).toBe(2500);
    } finally {
      source.close();
    }
  });

  test("bigint and blob cells arrive in a JSON-safe shape", () => {
    const path = dbAt(
      "cells.db",
      "CREATE TABLE events (big INTEGER, payload BLOB);\n" +
        "INSERT INTO events (big, payload) VALUES (9007199254740993, X'0102');",
    );
    const source = openSqliteSource(path, "events");
    try {
      const [row] = source.read(0, 10);
      // Past 2^53 the decimal string is the only lossless JSON shape.
      expect(row?.values?.["big"]).toBe("9007199254740993");
      expect(row?.values?.["payload"]).toBeInstanceOf(Uint8Array);
    } finally {
      source.close();
    }
  });

  test("the declared columns come back for the mapping check", () => {
    const path = dbAt("cols.db", LEGACY_EVENTS_FIXTURE.sql);
    const source = openSqliteSource(path, "events");
    try {
      expect(source.columns).toEqual(LEGACY_EVENTS_FIXTURE.columns);
    } finally {
      source.close();
    }
  });

  test("size is zero for an empty table", () => {
    const path = dbAt("none.db", "CREATE TABLE events (id TEXT);");
    const source = openSqliteSource(path, "events");
    try {
      expect(source.size()).toBe(0);
      expect(source.read(0, 10)).toEqual([]);
    } finally {
      source.close();
    }
  });
});

describe("the jsonl reader", () => {
  test("positions are the byte offset past each newline", () => {
    const path = jsonlAt("two.jsonl", '{"a":1}\n{"a":2}\n');
    const source = openJsonlSource(path);
    try {
      expect(source.read(0, 10)).toEqual([
        { position: 8, values: { a: 1 } },
        { position: 16, values: { a: 2 } },
      ]);
      expect(source.read(8, 10)).toEqual([{ position: 16, values: { a: 2 } }]);
      expect(source.size()).toBe(16);
    } finally {
      source.close();
    }
  });

  test("a line split across a read boundary is reassembled", () => {
    const first = "y".repeat(900 * 1024);
    const second = "z".repeat(300 * 1024);
    const path = jsonlAt(
      "wide.jsonl",
      `${JSON.stringify({ a: first })}\n${JSON.stringify({ a: second })}\n`,
    );
    const source = openJsonlSource(path);
    try {
      const rows = source.read(0, 10);
      expect(rows).toHaveLength(2);
      expect((rows[0]?.values as Record<string, unknown>)["a"]).toBe(first);
      expect((rows[1]?.values as Record<string, unknown>)["a"]).toBe(second);
    } finally {
      source.close();
    }
  });

  test("CRLF endings and a final unterminated line both read", () => {
    const path = jsonlAt("crlf.jsonl", '{"a":1}\r\n{"a":2}');
    const source = openJsonlSource(path);
    try {
      const rows = source.read(0, 10);
      expect(rows.map((row) => row.values)).toEqual([{ a: 1 }, { a: 2 }]);
      expect(rows[1]?.position).toBe(source.size());
    } finally {
      source.close();
    }
  });

  test("a line past the cap is reported and the next line still reads", () => {
    const huge = "z".repeat(MAX_LINE_BYTES + 10);
    const path = jsonlAt(
      "huge.jsonl",
      `${JSON.stringify({ a: huge })}\n${JSON.stringify({ b: 2 })}\n`,
    );
    const source = openJsonlSource(path);
    try {
      const rows = source.read(0, 10);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ values: null, problem: "line_too_long" });
      expect(rows[1]?.values).toEqual({ b: 2 });
    } finally {
      source.close();
    }
  });

  test("malformed and non-object lines are reported by position", () => {
    const path = jsonlAt("bad.jsonl", '{"a":1}\nnot json\n[1,2]\n\n{"b":2}\n');
    const source = openJsonlSource(path);
    try {
      expect(source.read(0, 10)).toEqual([
        { position: 8, values: { a: 1 } },
        { position: 17, values: null, problem: "malformed_json" },
        { position: 23, values: null, problem: "not_an_object" },
        { position: 24, values: null, problem: "not_an_object" },
        { position: 32, values: { b: 2 } },
      ]);
    } finally {
      source.close();
    }
  });

  test("paging by a small limit visits every line once", () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ i }),
    ).join("\n");
    const path = jsonlAt("many.jsonl", `${lines}\n`);
    const source = openJsonlSource(path);
    try {
      const positions = drain(source, 10);
      expect(positions).toHaveLength(25);
      expect(new Set(positions).size).toBe(25);
    } finally {
      source.close();
    }
  });

  test("an empty file yields nothing", () => {
    const path = jsonlAt("empty.jsonl", "");
    const source = openJsonlSource(path);
    try {
      expect(source.read(0, 10)).toEqual([]);
      expect(source.size()).toBe(0);
    } finally {
      source.close();
    }
  });

  test("a missing file is a refusal, not a crash", () => {
    expect(() => openJsonlSource(join(root, "absent.jsonl"))).toThrow(
      /cannot open/,
    );
  });
});
