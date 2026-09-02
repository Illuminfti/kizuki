import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/ledger/db";
import { accept, count } from "../src/ledger/ledger";
import { validEvent } from "./fixtures";

function schemaVersion(db: Database): number {
  return (
    db.query<{ version: number }, []>("SELECT version FROM schema_version").get()
      ?.version ?? 0
  );
}

describe("openLedger migrations", () => {
  test("applies the current migrations and enables foreign keys", () => {
    const db = openLedger(":memory:");
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(2);
    expect(
      db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get(),
    ).toEqual({ foreign_keys: 1 });
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining([
      "canon_holds",
      "checkpoints",
      "connections",
      "event_purges",
      "events",
      "schema_version",
    ]));
    db.close();
  });

  test("reopening a current database is a no-op", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const first = openLedger(path);
      const version = schemaVersion(first);
      expect(accept(first, validEvent()).status).toBe("stored");
      first.close();

      const reopened = openLedger(path);
      expect(count(reopened)).toBe(1);
      expect(schemaVersion(reopened)).toBe(version);
      expect(
        reopened.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get(),
      ).toEqual({ journal_mode: "wal" });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the current schema keys connector state by source", () => {
    const db = openLedger(":memory:");
    const columns = (table: string) =>
      db
        .query<
          { name: string; notnull: number; pk: number },
          [string]
        >("SELECT * FROM pragma_table_info(?) ORDER BY cid")
        .all(table)
        .map(({ name, notnull, pk }) => ({ name, notnull, pk }));

    expect(columns("checkpoints")).toEqual([
      { name: "connector_id", notnull: 1, pk: 1 },
      { name: "source_key", notnull: 1, pk: 2 },
      { name: "cursor", notnull: 0, pk: 0 },
      { name: "mode", notnull: 1, pk: 0 },
      { name: "updated_at", notnull: 1, pk: 0 },
      { name: "last_run_at", notnull: 1, pk: 0 },
      { name: "last_result", notnull: 1, pk: 0 },
    ]);
    expect(columns("connections").map(({ name, pk }) => ({ name, pk }))).toEqual([
      { name: "connector_id", pk: 1 },
      { name: "source_key", pk: 2 },
      { name: "config", pk: 0 },
      { name: "secret_refs", pk: 0 },
      { name: "connected_at", pk: 0 },
      { name: "disconnected_at", pk: 0 },
    ]);
    db.close();
  });

  test("upgrades v1 without losing events or legacy receipt hashes", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v1-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (1);
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
          accepted_at TEXT NOT NULL,
          UNIQUE(connector_id, source_record_id, content_hash)
        );
        CREATE TABLE event_purges (
          receipt_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          connector_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          purged_at TEXT NOT NULL
        );
        CREATE TABLE promotions (
          receipt_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL UNIQUE,
          provenance TEXT NOT NULL,
          sensitivity TEXT NOT NULL,
          page_path TEXT NOT NULL,
          page_hash TEXT NOT NULL,
          at TEXT NOT NULL
        ) STRICT;
        INSERT INTO events VALUES (
          '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'fixture', 'legacy', 'message',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'kept', '[]',
          NULL, 0, '[]', '{}', '${"a".repeat(64)}', '2026-01-01T00:00:00Z'
        );
        INSERT INTO promotions VALUES (
          'receipt-1', 'proposal-1', '["event-1"]', 'personal',
          'facts/legacy.md', '${"b".repeat(64)}', '2026-01-01T00:00:00Z'
        );
      `);
      legacy.close();

      const upgraded = openLedger(path);
      expect(schemaVersion(upgraded)).toBeGreaterThanOrEqual(2);
      expect(
        upgraded.query<{ text: string }, []>("SELECT text FROM events").get(),
      ).toEqual({ text: "kept" });
      const tables = upgraded
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map(({ name }) => name);
      const receiptsTable = tables.includes("canon_receipts")
        ? "canon_receipts"
        : "promotions";
      expect(
        upgraded
          .query<{
            kind: string;
            before_hash: string | null;
            after_hash: string;
          }, []>(`SELECT kind, before_hash, after_hash FROM ${receiptsTable}`)
          .get(),
      ).toEqual({
        kind: "claim",
        before_hash: null,
        after_hash: "b".repeat(64),
      });
      expect(
        upgraded
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all(receiptsTable)
          .map(({ name }) => name),
      ).not.toContain("page_hash");
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.todo(
    "claims-core and canon-writer lanes: v2 proposals and legacy receipts migrate to RFC 0002 storage",
  );
});
