import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/ledger/db";
import { accept, count } from "../src/ledger/ledger";
import { validEvent } from "./fixtures";

describe("openLedger migrations", () => {
  test("applies migrations through v2 and enables foreign keys", () => {
    const db = openLedger(":memory:");
    expect(
      db.query<{ version: number }, []>("SELECT version FROM schema_version").get(),
    ).toEqual({ version: 2 });
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
    ).toEqual([
      "canon_holds",
      "checkpoints",
      "connections",
      "event_purges",
      "events",
      "promotions",
      "schema_version",
    ]);
    db.close();
  });

  test("reopening a v2 database is a no-op", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const first = openLedger(path);
      expect(accept(first, validEvent()).status).toBe("stored");
      first.close();

      const reopened = openLedger(path);
      expect(count(reopened)).toBe(1);
      expect(
        reopened
          .query<{ version: number }, []>("SELECT version FROM schema_version")
          .get(),
      ).toEqual({ version: 2 });
      expect(
        reopened.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get(),
      ).toEqual({ journal_mode: "wal" });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("v2 keys connector state by source and carries promotion hashes", () => {
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
    expect(columns("promotions").map(({ name }) => name)).toEqual([
      "receipt_id",
      "proposal_id",
      "provenance",
      "sensitivity",
      "page_path",
      "kind",
      "before_hash",
      "after_hash",
      "at",
    ]);
    db.close();
  });

  test("upgrades v1 without losing events or promotion hashes", () => {
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
      expect(
        upgraded.query<{ version: number }, []>("SELECT version FROM schema_version").get(),
      ).toEqual({ version: 2 });
      expect(
        upgraded.query<{ text: string }, []>("SELECT text FROM events").get(),
      ).toEqual({ text: "kept" });
      expect(
        upgraded
          .query<{
            kind: string;
            before_hash: string | null;
            after_hash: string;
          }, []>("SELECT kind, before_hash, after_hash FROM promotions")
          .get(),
      ).toEqual({
        kind: "claim",
        before_hash: null,
        after_hash: "b".repeat(64),
      });
      expect(
        upgraded
          .query<{ name: string }, []>("PRAGMA table_info(promotions)")
          .all()
          .map(({ name }) => name),
      ).not.toContain("page_hash");
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
