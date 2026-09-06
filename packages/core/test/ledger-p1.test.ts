import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../src/index";
import { insertClaim } from "../src/claims/store";
import { LEDGER_SCHEMA_VERSION, inspectOpenLedgerHealth, openLedger } from "../src/ledger/db";
import { classifySqliteFailure, LedgerStoreError } from "../src/ledger/errors";
import { LEDGER_BUSY_TIMEOUT_MS, MAX_READ_SINCE } from "../src/ledger/limits";
import { accept, readSince, replay } from "../src/ledger/ledger";
import { validEvent } from "./fixtures";

function stored(db: Database, source = "rec-1") {
  const result = accept(db, { ...validEvent(), source_record_id: source });
  if (result.status !== "stored") throw new Error(`expected stored, got ${result.status}`);
  return result.event;
}

describe("ledger p1 store", () => {
  test("events is STRICT with fail-closed deleted and hash checks", () => {
    const db = openLedger(":memory:");
    expect(
      db.query<{ strict: number }, []>(
        "SELECT strict FROM pragma_table_list WHERE name = 'events'",
      ).get()?.strict,
    ).toBe(1);
    expect(() =>
      db.exec(
        "INSERT INTO events VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV','x','y','message','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','','[]',NULL,2,'[]','{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-01-01T00:00:00Z')",
      ),
    ).toThrow();
    db.close();
  });

  test("schema_version is a singleton and repairs duplicate equal rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-schema-version-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const raw = new Database(path);
      raw.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (0);
        INSERT INTO schema_version VALUES (0);
      `);
      raw.close();
      const db = openLedger(path);
      expect(
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_version").get(),
      ).toEqual({ n: 1 });
      expect(
        db.query<{ id: number; version: number }, []>(
          "SELECT id, version FROM schema_version",
        ).get(),
      ).toEqual({ id: 1, version: LEDGER_SCHEMA_VERSION });
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("conflicting schema_version rows fail closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-schema-conflict-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const raw = new Database(path);
      raw.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (1);
        INSERT INTO schema_version VALUES (2);
      `);
      raw.close();
      expect(() => openLedger(path)).toThrow(/conflicting values/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("open refuses a version stamp whose events table is not STRICT", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-schema-shape-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const db = openLedger(path);
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TABLE events");
      db.exec(`
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          source_record_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          text TEXT NOT NULL,
          subjects TEXT NOT NULL,
          sensitivity_hint TEXT,
          deleted INTEGER NOT NULL,
          attachments TEXT NOT NULL,
          metadata TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          accepted_at TEXT NOT NULL
        );
      `);
      db.close();
      expect(() => openLedger(path)).toThrow(/STRICT|schema/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("sets a bounded busy timeout", () => {
    const db = openLedger(":memory:");
    expect(
      db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout,
    ).toBe(LEDGER_BUSY_TIMEOUT_MS);
    db.close();
  });

  test("two connections surface busy as infrastructure, not a bad record", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-busy-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const writer = openLedger(path);
      stored(writer, "rec-lock");
      writer.exec("BEGIN EXCLUSIVE");
      const reader = new Database(path);
      reader.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
      let failed: unknown;
      try {
        reader.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        failed = error;
      }
      writer.exec("COMMIT");
      reader.close();
      writer.close();
      expect(failed).toBeDefined();
      expect(String(failed)).toMatch(/BUSY|locked|database is locked/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reading a deleted value other than 0 or 1 fails closed", () => {
    const db = openLedger(":memory:");
    const event = stored(db);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.query("UPDATE events SET deleted = 2 WHERE event_id = ?").run(event.event_id);
    expect(() => readSince(db, null, 1)).toThrow(LedgerStoreError);
    db.close();
  });

  test("reading recomputes the content hash and rejects drift", () => {
    const db = openLedger(":memory:");
    const event = stored(db);
    db.exec("DROP TRIGGER events_identity_update");
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.query("UPDATE events SET content_hash = ? WHERE event_id = ?").run(
      "b".repeat(64),
      event.event_id,
    );
    expect(() => readSince(db, null, 1)).toThrow(LedgerStoreError);
    db.close();
  });

  test("accept throws infrastructure errors instead of returning a record error", () => {
    const db = openLedger(":memory:");
    db.close();
    expect(() => accept(db, validEvent())).toThrow();
  });

  test("foreign-key and check failures are infrastructure, not a bad record", () => {
    const foreignKey = Object.assign(new Error("FOREIGN KEY constraint failed"), {
      code: "SQLITE_CONSTRAINT_FOREIGNKEY",
    });
    const check = Object.assign(new Error("CHECK constraint failed: events"), {
      code: "SQLITE_CONSTRAINT_CHECK",
    });
    const missing = Object.assign(new Error("NOT NULL constraint failed: events.text"), {
      code: "SQLITE_CONSTRAINT_NOTNULL",
    });
    const unique = Object.assign(new Error("UNIQUE constraint failed"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    expect(classifySqliteFailure(foreignKey)).toMatchObject({
      code: "infrastructure",
    });
    expect(classifySqliteFailure(check)).toMatchObject({ code: "infrastructure" });
    expect(classifySqliteFailure(missing)).toMatchObject({ code: "infrastructure" });
    expect(classifySqliteFailure(unique)).toBeNull();

    const db = openLedger(":memory:");
    db.exec(`
      CREATE TRIGGER fail_fk BEFORE INSERT ON events
      BEGIN
        SELECT RAISE(ABORT, 'SQLITE_CONSTRAINT_FOREIGNKEY');
      END;
    `);
    expect(() => accept(db, validEvent())).toThrow(LedgerStoreError);
    db.close();
  });

  test("readSince retains the last token at end-of-stream", () => {
    const db = openLedger(":memory:");
    const first = stored(db, "a");
    const page = readSince(db, null, 10);
    expect(page.exhausted).toBe(true);
    expect(page.cursor).toEqual({
      accepted_at: expect.any(String),
      event_id: first.event_id,
    });
    const again = readSince(db, page.cursor, 10);
    expect(again.events).toEqual([]);
    expect(again.exhausted).toBe(true);
    expect(again.cursor).toEqual(page.cursor);
    db.close();
  });

  test("readSince rejects a limit above the core cap", () => {
    const db = openLedger(":memory:");
    expect(() => readSince(db, null, MAX_READ_SINCE + 1)).toThrow(LedgerStoreError);
    db.close();
  });

  test("replay rejects malformed filters and pages internally", () => {
    const db = openLedger(":memory:");
    stored(db, "a");
    expect(() => [...replay(db, { since: "yesterday" })]).toThrow(/RFC3339/);
    expect(() => [...replay(db, { connector_id: "" })]).toThrow(/connector_id/);
    expect([...replay(db, { kind: "message" })]).toHaveLength(1);
    db.close();
  });

  test("doctor integrity reports ok on a fresh ledger and names row damage", () => {
    const db = openLedger(":memory:");
    const healthy = inspectOpenLedgerHealth(db);
    expect(healthy.ok).toBe(true);
    expect(healthy.quick_check).toBe("ok");
    const event = stored(db);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.query("UPDATE events SET deleted = -1 WHERE event_id = ?").run(event.event_id);
    const damaged = inspectOpenLedgerHealth(db);
    expect(damaged.ok).toBe(false);
    expect(damaged.failures.some((failure) => failure.kind === "row")).toBe(true);
    expect(JSON.stringify(damaged)).not.toContain("the kettle is on");
    db.close();
  });

  test("the public barrel does not export openLedger", () => {
    expect(Object.hasOwn(core, "openLedger")).toBe(false);
    expect(typeof core.inspectLedgerHealth).toBe("function");
    expect(typeof core.LedgerStoreError).toBe("function");
  });

  test("a claims write leaves close(true) possible", async () => {
    const db = openLedger(":memory:");
    try {
      const event = stored(db);
      const result = await insertClaim(
        { db, now: () => "2026-09-05T00:00:00.000Z" },
        {
          kind: "claim",
          subject: "person:grace",
          predicate: "employment.works_at",
          object: "acme",
          polarity: "positive",
          body: "Grace runs partnerships at Acme.",
          provenance: [event.event_id],
          subjects: ["person:grace"],
          producer: "deterministic",
          confidence: 0.8,
          sensitivity: "personal",
          taint: "clean",
        },
      );
      expect(result.outcome).toBe("stored");
      expect(() => db.close(true)).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("agent_audit is not keyed to agents so owner rows can persist", () => {
    const db = openLedger(":memory:");
    const sql =
      db
        .query<{ sql: string | null }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_audit'",
        )
        .get()?.sql ?? "";
    expect(sql).not.toContain("REFERENCES agents");
    db.exec(
      `INSERT INTO agent_audit VALUES (
        '01ARZ3NDEKTSV4RRFFQ69G5FAV','owner','timeline','{}','[]','[]',0,0,NULL,'2026-01-01T00:00:00Z'
      )`,
    );
    db.close();
  });
});
