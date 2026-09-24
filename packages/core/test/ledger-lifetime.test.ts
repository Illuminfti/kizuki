import { expect, test, setDefaultTimeout } from "bun:test";
import { Database, constants } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/ledger/db";
import { QUERY_CACHE_LIMIT, manageDatabaseLifetime } from "../src/ledger/lifetime";
import { configureLedgerWalLifecycle } from "../src/ledger/wal-lifecycle";

// These tests spawn real processes; bound them for a loaded host.
setDefaultTimeout(30_000);

for (const strict of [false, true]) test(`ledger close(${strict}) finalizes held uncached queries and a prepared iterator`, () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-lifetime-")), path = join(root, "ledger.db");
  const db = openLedger(path);
  const statements = Array.from({ length: 30 }, (_, i) => db.query(`SELECT ${i} AS n`));
  const prepared = db.prepare("SELECT 1 AS n UNION ALL SELECT 2 AS n");
  const iterator = prepared.iterate();
  try {
    db.exec("CREATE TABLE held_close_fixture(n); INSERT INTO held_close_fixture VALUES(7)");
    expect(iterator.next().done).toBe(false);
    expect(existsSync(path + "-wal")).toBe(true);
    expect(() => db.close(strict)).not.toThrow();
    for (const statement of [...statements, prepared]) expect(() => statement.get()).toThrow();
    expect(existsSync(path + "-wal")).toBe(false);
    expect(existsSync(path + "-shm")).toBe(false);
    // Match the readable-WAL contract without CREATE, migrations or SQL writes.
    const reader = new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW);
    try {
      configureLedgerWalLifecycle(reader, path);
      reader.exec("PRAGMA query_only=ON");
      expect(reader.query("SELECT n FROM held_close_fixture").get()).toEqual({ n: 7 });
      expect(() => reader.exec("DELETE FROM held_close_fixture")).toThrow();
    }
    finally { reader.close(true); }
    expect(() => db.close(strict)).not.toThrow();
  } finally {
    for (const statement of [...statements, prepared]) statement.finalize();
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("cache identity, manual finalization, fluent statements and transaction reuse survive until close", () => {
  const db = manageDatabaseLifetime(new Database(":memory:"));
  try {
    expect(manageDatabaseLifetime(db)).toBe(db);
    const first = db.query("SELECT 7 AS n");
    expect(db.query("SELECT 7 AS n")).toBe(first);
    expect(first.as(class Row { n!: number; }).get()).toMatchObject({ n: 7 });
    first.finalize();
    const replacement = db.query("SELECT 7 AS n");
    expect(replacement).not.toBe(first);
    const tx = db.transaction(() => replacement.get());
    expect(tx()).toMatchObject({ n: 7 });
    expect(tx.immediate()).toMatchObject({ n: 7 });
    db.close(true);
    expect(() => replacement.get()).toThrow();
    expect(() => first.finalize()).not.toThrow();
    expect(() => db[Symbol.dispose]()).not.toThrow();
  } finally { db.close(); }
});

test("borrowed methods keep statements with the receiving database", () => {
  const first = manageDatabaseLifetime(new Database(":memory:"));
  const second = manageDatabaseLifetime(new Database(":memory:"));
  const a = first.prepare("SELECT 1 AS n"), b = first.prepare.call(second, "SELECT 2 AS n");
  try {
    first.close(true);
    expect(() => a.get()).toThrow();
    expect(b.get()).toEqual({ n: 2 });
    first.close.call(second, true);
    expect(() => b.get()).toThrow();
  } finally { first.close(); second.close(); }
});

test("close preserves its caller's argument list and invokes the original after a finalizer failure", () => {
  const db = new Database(":memory:"), originalClose = db.close;
  const calls: unknown[][] = [];
  db.close = function(...args) { calls.push(args); return Reflect.apply(originalClose, this, args); };
  manageDatabaseLifetime(db);
  const failed = db.prepare("SELECT 1"), healthy = db.prepare("SELECT 2");
  const originalFinalize = failed.finalize, failure = new Error("synthetic finalizer failure");
  let attempts = 0;
  failed.finalize = function() { if (++attempts === 1) throw failure; return originalFinalize.call(this); };
  try {
    expect(() => db.close(false)).toThrow(failure);
    expect(calls).toEqual([[false]]);
    expect(() => healthy.get()).toThrow();
    expect(() => db.close(true)).not.toThrow();
    expect(attempts).toBe(2);
    expect(() => failed.get()).toThrow();
    expect(() => db.close()).not.toThrow();
    expect(calls).toEqual([[false], [true], []]);
  } finally { failed.finalize = originalFinalize; failed.finalize(); db.close(); }
});

test("finalizer and original-close errors are both retained and a later close can finish", () => {
  const db = new Database(":memory:"), originalClose = db.close;
  const closeFailure = new Error("synthetic close failure"), finalizeFailure = new Error("synthetic finalize failure");
  let closes = 0;
  db.close = function(...args) { if (++closes === 1) throw closeFailure; return Reflect.apply(originalClose, this, args); };
  manageDatabaseLifetime(db);
  const statement = db.prepare("SELECT 3"), originalFinalize = statement.finalize;
  let finalizes = 0;
  statement.finalize = function() { if (++finalizes === 1) throw finalizeFailure; return originalFinalize.call(this); };
  try {
    let failure: unknown;
    try { db.close(true); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([finalizeFailure, closeFailure]);
    expect(() => db.close(true)).not.toThrow();
    expect(closes).toBe(2);
    expect(() => statement.get()).toThrow();
  } finally { statement.finalize = originalFinalize; statement.finalize(); db.close(); }
});

test("the lifetime registry does not strongly retain uncached statements", () => {
  const script = `
    import { Database } from "bun:sqlite";
    import { strict as assert } from "node:assert";
    import { manageDatabaseLifetime } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/lifetime.ts"))};
    const db = manageDatabaseLifetime(new Database(":memory:"));
    let reference;
    (() => { const statement = db.prepare("SELECT 1"); reference = new WeakRef(statement); })();
    await Bun.sleep(0);
    for(let i=0;i<5;i++) { Bun.gc(true); await Bun.sleep(0); }
    assert.equal(reference.deref(), undefined);
    db.close(true);
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.length).toBe(0); expect(child.stderr.length).toBe(0);
});

test("query() keeps reusing statements after Bun's 20-entry query cache fills", () => {
  const db = new Database(":memory:"), originalPrepare = db.prepare;
  let prepared = 0;
  db.prepare = function(this: Database, ...args: Parameters<Database["prepare"]>) {
    prepared += 1;
    return Reflect.apply(originalPrepare, this, args);
  } as Database["prepare"];
  manageDatabaseLifetime(db);
  try {
    const sql = Array.from({ length: 64 }, (_, i) => `SELECT ${i} AS n`);
    const first = sql.map(text => db.query(text));
    for (let round = 0; round < 50; round++) sql.forEach((text, i) => expect(db.query(text)).toBe(first[i]!));
    expect(prepared).toBe(sql.length);
  } finally { db.close(); }
});

test("a long synchronous pass does not pin a statement per query", () => {
  const script = `
    import { Database } from "bun:sqlite";
    import { manageDatabaseLifetime } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/lifetime.ts"))};
    const db = manageDatabaseLifetime(new Database(":memory:"));
    const sql = Array.from({ length: 64 }, (_, i) => "SELECT " + i + " AS n WHERE ?1 IS NOT NULL");
    for (const text of sql) db.query(text).get(1);
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 100_000; i++) db.query(sql[i % sql.length]).get(i);
    const grown = process.memoryUsage().rss - before;
    if (grown > 64 * 1024 * 1024) throw new Error("one synchronous pass grew " + grown + " bytes");
    db.close(true);
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});

test("explicitly finalized statements are released within one synchronous pass", () => {
  const script = `
    import { Database } from "bun:sqlite";
    import { manageDatabaseLifetime } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/lifetime.ts"))};
    const db = manageDatabaseLifetime(new Database(":memory:"));
    const held = db.prepare("SELECT 1 AS n");
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 600_000; i++) { using statement = db.prepare("SELECT ?1 AS n"); statement.get(i); }
    const grown = process.memoryUsage().rss - before;
    if (grown > 320 * 1024 * 1024) throw new Error("one synchronous pass grew " + grown + " bytes");
    db.close(true);
    if (!held.isFinalized) throw new Error("a held statement survived close");
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});

test("the query cache is bounded; an evicted statement serves its holder until close", () => {
  const db = manageDatabaseLifetime(new Database(":memory:"));
  try {
    for (let i = 0; i < 20; i++) db.query(`SELECT ${i} AS bun_cached`);
    const held = db.query("SELECT -1 AS n");
    for (let i = 0; i < QUERY_CACHE_LIMIT; i++) db.query(`SELECT ${i} AS n`);
    expect(db.query("SELECT -1 AS n")).not.toBe(held);
    expect(held.get()).toEqual({ n: -1 });
    db.close(true);
    expect(() => held.get()).toThrow();
  } finally { db.close(); }
});

test("a finalizer that returns without finalizing is refused and remains retryable", () => {
  const db = manageDatabaseLifetime(new Database(":memory:"));
  const statement = db.prepare("SELECT 1"), originalFinalize = statement.finalize;
  statement.finalize = () => {};
  try {
    expect(() => db.close()).toThrow("database statement did not finalize");
    statement.finalize = originalFinalize;
    expect(() => db.close()).not.toThrow();
    expect(() => statement.get()).toThrow();
  } finally { statement.finalize = originalFinalize; statement.finalize(); db.close(); }
});

const ROWS_SQL = "SELECT n FROM rows_fixture ORDER BY n";

/** A file WAL ledger, a second connection, and ROWS_SQL either within Bun's
 * 20-entry query() cache or past it. */
function walFixture(pastBunCache: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ledger-lifetime-iterate-")), path = join(root, "ledger.db");
  const db = manageDatabaseLifetime(new Database(path));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE rows_fixture(n INTEGER); INSERT INTO rows_fixture VALUES(1),(2),(3)");
  if (pastBunCache) for (let i = 0; i < 25; i++) db.query(`SELECT ${i} AS filler`).get();
  const other = new Database(path);
  return { db, other, dispose() { other.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function collectGarbage(): Promise<void> {
  for (let i = 0; i < 5; i++) { Bun.gc(true); await Bun.sleep(0); }
}

const earlyExits: Record<string, (db: Database) => void> = {
  break: db => { for (const _ of db.query(ROWS_SQL).iterate()) break; },
  return: db => { (() => { for (const row of db.query(ROWS_SQL).iterate()) return row; })(); },
  "throw in a rolled-back transaction": db => {
    expect(() => db.transaction(() => { for (const _ of db.query(ROWS_SQL).iterate()) throw new Error("refused"); }).deferred()).toThrow("refused");
  },
  "abandoned iterator": db => { (() => { db.query(ROWS_SQL).iterate().next(); })(); },
};

for (const pastBunCache of [false, true]) for (const [exit, leave] of Object.entries(earlyExits)) {
  test(`a query() iteration left early (${exit}, ${pastBunCache ? "past" : "within"} Bun's cache) releases its read snapshot`, async () => {
    const { db, other, dispose } = walFixture(pastBunCache);
    try {
      leave(db);
      await collectGarbage();
      other.run("INSERT INTO rows_fixture VALUES(4)");
      expect(db.query<{ rows: number }, []>("SELECT count(*) AS rows FROM rows_fixture").get()).toEqual({ rows: 4 });
      expect(() => db.transaction(() => db.run("INSERT INTO rows_fixture VALUES(5)")).immediate()).not.toThrow();
      expect(other.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
      expect(db.query<{ n: number }, []>(ROWS_SQL).all().map(row => row.n)).toEqual([1, 2, 3, 4, 5]);
    } finally { dispose(); }
  });
}

for (const pastBunCache of [false, true]) test(`a nested query() of SQL mid-iteration gets its own statement (${pastBunCache ? "past" : "within"} Bun's cache)`, () => {
  const { db, dispose } = walFixture(pastBunCache);
  try {
    const outer: number[] = [];
    for (const row of db.query<{ n: number }, []>(ROWS_SQL).iterate()) {
      outer.push(row.n);
      expect(db.query<{ n: number }, []>(ROWS_SQL).all().map(inner => inner.n)).toEqual([1, 2, 3]);
      for (const _ of db.query(ROWS_SQL).iterate()) break;
      if (outer.length > 3) break;
    }
    expect(outer).toEqual([1, 2, 3]);
  } finally { dispose(); }
});
