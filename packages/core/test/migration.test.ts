import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentsV9 } from "../src/agents/schema";
import { applyCanonV4, initCanon } from "../src/canon/schema";
import { getCanonReceipt } from "../src/canon/receipts";
import { applyClaimsV3, initClaims } from "../src/claims/schema";
import { neighbors } from "../src/graph/graph";
import { initGraph } from "../src/graph/schema";
import { applyConnectionsV8 } from "../src/ledger/connections-schema";
import { openLedger } from "../src/ledger/db";
import { tableExists } from "../src/ledger/schema";
import { initSearch } from "../src/search/schema";
import { searchResult } from "../src/search/query";
import { accept, count } from "../src/ledger/ledger";
import { validEvent } from "./fixtures";

function schemaVersion(db: Database): number {
  return (
    db.query<{ version: number }, []>("SELECT version FROM schema_version").get()
      ?.version ?? 0
  );
}

const V2_SCHEMA = `
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (2);
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
        CREATE TABLE connections (
          connector_id TEXT NOT NULL,
          source_key TEXT NOT NULL,
          config TEXT NOT NULL,
          secret_refs TEXT NOT NULL,
          connected_at TEXT NOT NULL,
          disconnected_at TEXT,
          PRIMARY KEY (connector_id, source_key)
        ) STRICT;
        CREATE TABLE checkpoints (
          connector_id TEXT NOT NULL,
          source_key TEXT NOT NULL,
          cursor TEXT,
          mode TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_run_at TEXT NOT NULL,
          last_result TEXT NOT NULL,
          PRIMARY KEY (connector_id, source_key)
        ) STRICT;
        CREATE TABLE canon_holds (
          page_path TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          held_at TEXT NOT NULL,
          PRIMARY KEY (page_path, proposal_id)
        ) STRICT;
        CREATE TABLE promotions (
          receipt_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL UNIQUE,
          provenance TEXT NOT NULL,
          sensitivity TEXT NOT NULL,
          page_path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'claim',
          before_hash TEXT,
          after_hash TEXT NOT NULL,
          at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE proposals (
          proposal_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          target TEXT,
          body TEXT NOT NULL,
          frontmatter TEXT NOT NULL,
          provenance TEXT NOT NULL,
          subjects TEXT NOT NULL,
          producer TEXT NOT NULL,
          confidence REAL NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          body_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE rejections (
          body_hash TEXT NOT NULL,
          reason TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          at TEXT NOT NULL,
          PRIMARY KEY (body_hash, proposal_id)
        ) STRICT;
`;

describe("openLedger migrations", () => {
  test("applies the current migrations and enables foreign keys", () => {
    const db = openLedger(":memory:");
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(3);
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
      "claim_bindings",
      "claim_supersessions",
      "claims",
      "connections",
      "event_purges",
      "events",
      "proposals",
      "purge_ops",
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
      { name: "implementation_version", pk: 0 },
      { name: "consent_required", pk: 0 },
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

  test("upgrades v2 proposals and rejections into RFC 0002 claims", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v2-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec(V2_SCHEMA);
      legacy.exec(`
        INSERT INTO events VALUES (
          '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'fixture', 'legacy', 'message',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'kept', '[]',
          NULL, 0, '[]', '{}', '${"a".repeat(64)}', '2026-01-01T00:00:00Z'
        );
        INSERT INTO proposals VALUES (
          'proposal-live', 'claim', NULL, 'Ada works at Acme.', '{}',
          '["01ARZ3NDEKTSV4RRFFQ69G5FAV"]', '["person:ada"]', 'deterministic',
          0.8, 'pending', '2026-01-02T00:00:00Z', '${"c".repeat(64)}'
        );
        INSERT INTO proposals VALUES (
          'proposal-promoted', 'entity', 'person:ada', 'Ada page.', '{}',
          '["01ARZ3NDEKTSV4RRFFQ69G5FAV"]', '["person:ada"]', 'deterministic',
          0.5, 'promoted', '2026-01-02T00:00:00Z', '${"d".repeat(64)}'
        );
        INSERT INTO rejections VALUES (
          '${"c".repeat(64)}', 'not true', 'proposal-live', '2026-01-03T00:00:00Z'
        );
      `);
      legacy.close();

      const upgraded = openLedger(path);
      expect(schemaVersion(upgraded)).toBe(15);
      const tables = upgraded
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map(({ name }) => name);
      expect(tables).toEqual(expect.arrayContaining([
        "claims",
        "claim_supersessions",
        "claim_bindings",
        "proposals",
        "canon_receipts",
        "page_index",
        "purge_ops",
        "connector_sensitivity",
        "schedules",
        "run_receipts",
        "leases",
        "budget_ledger",
        "connection_runs",
        "agents",
        "agent_grants",
        "agent_audit",
      ]));
      expect(tables).not.toContain("rejections");
      expect(tables).not.toContain("promotions");

      const statuses = upgraded
        .query<{ claim_id: string; status: string; valid_from: string }, []>(
          "SELECT claim_id, status, valid_from FROM claims ORDER BY claim_id",
        )
        .all();
      expect(statuses).toEqual(
        expect.arrayContaining([
          {
            claim_id: "proposal-live",
            status: "skipped",
            valid_from: "2026-01-02T00:00:00Z",
          },
          {
            claim_id: "proposal-promoted",
            status: "live",
            valid_from: "2026-01-02T00:00:00Z",
          },
        ]),
      );
      expect(
        upgraded
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all("claims")
          .map(({ name }) => name),
      ).toEqual(expect.arrayContaining([
        "subject",
        "predicate",
        "object",
        "polarity",
        "claim_key",
        "authority",
        "sensitivity",
        "taint",
        "valid_from",
        "corroboration",
      ]));
      expect(
        upgraded
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claims WHERE authority = 'owner_correction'")
          .get()?.n,
      ).toBeGreaterThanOrEqual(1);
      expect(
        upgraded
          .query<{ status: string }, []>(
            "SELECT status FROM proposals WHERE proposal_id = 'proposal-live'",
          )
          .get()?.status,
      ).toBe("pending");
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("initClaims is a no-op once the v3 surface exists", () => {
    const db = openLedger(":memory:");
    db.exec("DELETE FROM proposals");
    initClaims(db);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM proposals").get()?.n,
    ).toBe(0);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claims").get()?.n,
    ).toBe(0);
    db.close();
  });

  test("v3 claims and legacy receipts migrate to RFC 0002 receipt storage", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v3-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec(V2_SCHEMA);
      legacy.exec(`
        INSERT INTO events VALUES (
          '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'fixture', 'legacy', 'message',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'kept', '[]',
          NULL, 0, '[]', '{}', '${"a".repeat(64)}', '2026-01-01T00:00:00Z'
        );
        INSERT INTO proposals VALUES (
          'proposal-created', 'entity', 'person:ada', 'Ada page.', '{}',
          '["01ARZ3NDEKTSV4RRFFQ69G5FAV"]', '["person:ada"]', 'deterministic',
          0.5, 'promoted', '2026-01-02T00:00:00Z', '${"d".repeat(64)}'
        );
        INSERT INTO proposals VALUES (
          'proposal-edited', 'edit', 'person:ada', 'Ada edit.', '{}',
          '["01ARZ3NDEKTSV4RRFFQ69G5FAV"]', '["person:ada"]', 'deterministic',
          0.9, 'promoted', '2026-01-03T00:00:00Z', '${"e".repeat(64)}'
        );
        INSERT INTO promotions VALUES (
          'receipt-created', 'proposal-created', '["01ARZ3NDEKTSV4RRFFQ69G5FAV"]',
          'personal', 'person/ada.md', 'entity', NULL, '${"1".repeat(64)}',
          '2026-01-02T00:00:01Z'
        );
        INSERT INTO promotions VALUES (
          'receipt-edited', 'proposal-edited', '["01ARZ3NDEKTSV4RRFFQ69G5FAV"]',
          'personal', 'person/ada.md', 'edit', '${"1".repeat(64)}', '${"2".repeat(64)}',
          '2026-01-03T00:00:01Z'
        );
      `);
      applyClaimsV3(legacy);
      legacy.exec("UPDATE schema_version SET version = 3");
      legacy.close();

      const upgraded = openLedger(path);
      expect(schemaVersion(upgraded)).toBe(15);
      const receipts = upgraded
        .query<
          {
            receipt_id: string;
            claim_ids: string;
            kind: string;
            receipt_kind: string;
            page_action: string;
            archive_path: string | null;
            writer: string;
            producer: string;
            model_ref: string | null;
            authority: string;
            confidence: number;
            taint: string;
            before_hash: string | null;
            after_hash: string;
            candidates: string;
            superseded: string;
            reverts: string | null;
          },
          []
        >("SELECT * FROM canon_receipts ORDER BY at")
        .all();
      expect(receipts).toEqual([
        expect.objectContaining({
          receipt_id: "receipt-created",
          claim_ids: '["proposal-created"]',
          kind: "entity",
          receipt_kind: "write",
          page_action: "create",
          archive_path: null,
          writer: "import",
          producer: "deterministic",
          model_ref: null,
          authority: "connector_evidence",
          confidence: 1,
          taint: "quoted",
          before_hash: null,
          after_hash: "1".repeat(64),
          candidates: "[]",
          superseded: "[]",
          reverts: null,
        }),
        expect.objectContaining({
          receipt_id: "receipt-edited",
          claim_ids: '["proposal-edited"]',
          page_action: "edit",
          archive_path: null,
          writer: "import",
          before_hash: "1".repeat(64),
          after_hash: "2".repeat(64),
        }),
      ]);
      expect(getCanonReceipt(upgraded, "receipt-created")?.claim_ids).toEqual([
        "proposal-created",
      ]);
      expect(
        upgraded
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM page_index")
          .get()?.n,
      ).toBe(0);
      expect(
        upgraded
          .query<{ status: string }, []>(
            "SELECT status FROM claims WHERE claim_id = 'proposal-created'",
          )
          .get()?.status,
      ).toBe("live");

      applyCanonV4(upgraded);
      initCanon(upgraded);
      expect(
        upgraded
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM canon_receipts")
          .get()?.n,
      ).toBe(2);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a fresh database and every upgrade path expose the same v4 receipt columns", () => {
    const fresh = openLedger(":memory:");
    const columns = (db: Database, table: string) =>
      db
        .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?) ORDER BY name")
        .all(table)
        .map(({ name }) => name);
    const freshColumns = columns(fresh, "canon_receipts");
    expect(freshColumns).toEqual(expect.arrayContaining([
      "receipt_id",
      "claim_ids",
      "receipt_kind",
      "page_action",
      "archive_path",
      "writer",
      "producer",
      "model_ref",
      "authority",
      "confidence",
      "taint",
      "candidates",
      "superseded",
      "retrieval_ops",
      "reverts",
      "reverted_by",
    ]));
    expect(columns(fresh, "page_index")).toEqual([
      "last_hash",
      "last_receipt",
      "page_id",
      "rel_path",
      "subject_key",
    ]);

    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v2-cols-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec(V2_SCHEMA);
      legacy.close();
      const upgraded = openLedger(path);
      expect(columns(upgraded, "canon_receipts")).toEqual(freshColumns);
      expect(schemaVersion(fresh)).toBe(15);
      expect(schemaVersion(upgraded)).toBe(15);
      expect(columns(fresh, "connector_sensitivity")).toEqual([
        "at",
        "connector_id",
        "default_sensitivity",
        "floor",
        "set_by",
        "source_key",
      ]);
      expect(columns(upgraded, "connector_sensitivity")).toEqual(
        columns(fresh, "connector_sensitivity"),
      );
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      fresh.close();
    }
  });

  test("v4 databases gain purge_ops at schema v5", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v4-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec(V2_SCHEMA);
      applyClaimsV3(legacy);
      applyCanonV4(legacy);
      legacy.exec("UPDATE schema_version SET version = 4");
      expect(
        legacy
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'purge_ops'",
          )
          .get(),
      ).toBeNull();
      legacy.close();

      const upgraded = openLedger(path);
      expect(schemaVersion(upgraded)).toBe(15);
      expect(
        upgraded
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'purge_ops'",
          )
          .get()?.name,
      ).toBe("purge_ops");
      expect(
        upgraded
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all("purge_ops")
          .map(({ name }) => name)
          .sort(),
      ).toEqual([
        "created_at",
        "done_at",
        "ids",
        "op_id",
        "proof",
        "receipt_id",
        "state",
        "store",
      ]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("v7 leftover agent rows persist through v9 and fail closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v7-agents-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec(V2_SCHEMA);
      applyClaimsV3(legacy);
      applyCanonV4(legacy);
      legacy.exec("UPDATE schema_version SET version = 7");
      legacy.exec(`
        CREATE TABLE agents (
          agent_id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        ) STRICT;
        CREATE TABLE agent_grants (
          agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
          ceiling TEXT NOT NULL,
          types TEXT,
          subjects TEXT,
          since TEXT,
          until TEXT,
          tools TEXT NOT NULL,
          rate_limit_per_minute INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO agents VALUES (
          '01AGENT0000000000000000001',
          'legacy-reader',
          '${"ab".repeat(32)}',
          '2026-01-01T00:00:00.000Z',
          NULL
        );
        INSERT INTO agent_grants VALUES (
          '01AGENT0000000000000000001',
          'personal',
          NULL,
          NULL,
          NULL,
          NULL,
          '["search"]',
          60,
          '2026-01-01T00:00:00.000Z'
        );
      `);
      expect(
        legacy
          .query<{ name: string }, []>(
            "SELECT name FROM pragma_table_info('agent_grants')",
          )
          .all()
          .some(({ name }) => name === "grant_epoch"),
      ).toBe(false);
      legacy.close();

      const upgraded = openLedger(path);
      expect(schemaVersion(upgraded)).toBe(15);
      const grant = upgraded
        .query<
          { relay_owner_corrections: number; grant_epoch: number },
          []
        >(
          `SELECT relay_owner_corrections, grant_epoch FROM agent_grants
            WHERE agent_id = '01AGENT0000000000000000001'`,
        )
        .get();
      expect(grant).toEqual({ relay_owner_corrections: 0, grant_epoch: 1 });
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("v8 connection databases gain agent tables at schema v9", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v8-agents-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const leftover = new Database(path);
      leftover.exec(V2_SCHEMA);
      applyClaimsV3(leftover);
      applyCanonV4(leftover);
      applyConnectionsV8(leftover);
      leftover.exec("UPDATE schema_version SET version = 8");
      leftover.close();

      const upgraded = openLedger(path);
      expect(schemaVersion(upgraded)).toBe(15);
      const tables = upgraded
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map(({ name }) => name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "connection_runs",
          "agents",
          "agent_grants",
          "agent_audit",
        ]),
      );
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("v9 agent databases rebuild derived_meta at schema v10", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v9-derived-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const leftover = new Database(path);
      leftover.exec(V2_SCHEMA);
      applyClaimsV3(leftover);
      applyCanonV4(leftover);
      applyConnectionsV8(leftover);
      applyAgentsV9(leftover);
      leftover.exec(`
        CREATE TABLE derived_meta (
          layer TEXT PRIMARY KEY,
          rebuilt_at TEXT NOT NULL,
          doc_count INTEGER NOT NULL
        ) STRICT;
        INSERT INTO derived_meta VALUES ('search', '2026-01-01T00:00:00Z', 1);
        UPDATE schema_version SET version = 9;
      `);
      leftover.close();

      const upgraded = openLedger(path);
      expect(schemaVersion(upgraded)).toBe(15);
      expect(
        upgraded
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all("derived_meta")
          .map(({ name }) => name)
          .sort(),
      ).toEqual([
        "canon_hash",
        "contract",
        "doc_count",
        "generation",
        "layer",
        "ledger_watermark",
        "port_id",
        "rebuilt_at",
        "skipped_count",
        "source_count",
        "space",
        "status",
      ]);
      expect(
        upgraded
          .query<{ layer: string; status: string }, []>(
            "SELECT layer, status FROM derived_meta ORDER BY layer",
          )
          .all(),
      ).toEqual([
        { layer: "graph", status: "degraded" },
        { layer: "search", status: "degraded" },
      ]);
      expect(
        upgraded
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'",
          )
          .get()?.name,
      ).toBe("agents");
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("v7 databases rebuild derived_meta and graph identity at schema v10", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v7-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec(V2_SCHEMA);
      applyClaimsV3(legacy);
      applyCanonV4(legacy);
      legacy.exec(`
        CREATE TABLE derived_meta (
          layer TEXT PRIMARY KEY,
          rebuilt_at TEXT NOT NULL,
          doc_count INTEGER NOT NULL
        ) STRICT;
        INSERT INTO derived_meta VALUES ('search', '2026-01-01T00:00:00Z', 1);
        CREATE TABLE graph_edges (
          src TEXT NOT NULL,
          dst TEXT NOT NULL,
          kind TEXT NOT NULL,
          PRIMARY KEY (src, dst, kind)
        ) STRICT;
        INSERT INTO graph_edges VALUES ('fact:one', 'fact:two', 'wikilink');
        CREATE VIRTUAL TABLE search_docs USING fts5(page_id, body);
        INSERT INTO search_docs (page_id, body) VALUES ('fact:one', 'stale');
        UPDATE schema_version SET version = 7;
      `);
      legacy.close();

      const upgraded = openLedger(path);
      expect(schemaVersion(upgraded)).toBe(15);
      expect(
        upgraded
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all("derived_meta")
          .map(({ name }) => name)
          .sort(),
      ).toEqual([
        "canon_hash",
        "contract",
        "doc_count",
        "generation",
        "layer",
        "ledger_watermark",
        "port_id",
        "rebuilt_at",
        "skipped_count",
        "source_count",
        "space",
        "status",
      ]);
      expect(
        upgraded
          .query<{ layer: string; status: string }, []>(
            "SELECT layer, status FROM derived_meta ORDER BY layer",
          )
          .all(),
      ).toEqual([
        { layer: "graph", status: "degraded" },
        { layer: "search", status: "degraded" },
      ]);
      expect(searchResult(upgraded, "stale")).toEqual({
        hits: [],
        degraded: ["index-degraded"],
      });
      expect(neighbors(upgraded, "fact:one")).toEqual({
        id: "fact:one",
        edges: [],
        truncated: false,
      });
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("v10 does not invent search or graph on a fresh ledger", () => {
    const db = openLedger(":memory:");
    expect(tableExists(db, "search_docs")).toBe(false);
    expect(tableExists(db, "search_documents")).toBe(false);
    expect(tableExists(db, "graph_edges")).toBe(false);
    db.close();
  });

  test("v10 missing search_docs is projected from the companion", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v10-fts-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const first = openLedger(path);
      initSearch(first);
      first.exec(`
        INSERT INTO search_documents (
          doc_id, scope, title, body, path, page_type, sensitivity,
          taint, authority, occurred_at, connector_id, subjects, provenance
        ) VALUES (
          'page:fact:tea', 'canon', 'Tea', 'kettleword', 'facts/tea.md', 'fact',
          'public', 'clean', 'owner_authored', '2026-01-01T00:00:00Z', '',
          '[]', '[]'
        );
        INSERT INTO derived_meta (
          layer, generation, rebuilt_at, doc_count, source_count, skipped_count,
          status, ledger_watermark, canon_hash, port_id, contract, space
        ) VALUES (
          'search', 'gen-1', '2026-01-01T00:00:00Z', 1, 1, 0, 'ok',
          NULL, NULL, 'kizuki.retrieval.fts5', 'kizuki.retrieval/v1', NULL
        );
        DROP TABLE search_docs;
      `);
      first.close();

      const reopened = openLedger(path);
      expect(schemaVersion(reopened)).toBe(15);
      expect(searchResult(reopened, "kettleword")).toEqual({
        hits: [
          expect.objectContaining({
            doc_id: "page:fact:tea",
            title: "Tea",
          }),
        ],
        degraded: [],
      });
      expect(
        reopened
          .query<{ status: string }, []>(
            "SELECT status FROM derived_meta WHERE layer = 'search'",
          )
          .get()?.status,
      ).toBe("ok");
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("v10 missing search_docs without a companion is stamped degraded", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v10-fts-gap-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const first = openLedger(path);
      initSearch(first);
      first.exec(`
        INSERT INTO derived_meta (
          layer, generation, rebuilt_at, doc_count, source_count, skipped_count,
          status, ledger_watermark, canon_hash, port_id, contract, space
        ) VALUES (
          'search', 'gen-1', '2026-01-01T00:00:00Z', 1, 1, 0, 'ok',
          NULL, NULL, 'kizuki.retrieval.fts5', 'kizuki.retrieval/v1', NULL
        );
        DROP TABLE search_docs;
        DROP TABLE search_documents;
      `);
      first.close();

      const reopened = openLedger(path);
      expect(searchResult(reopened, "kettleword")).toEqual({
        hits: [],
        degraded: ["index-degraded"],
      });
      expect(
        reopened
          .query<{ status: string }, []>(
            "SELECT status FROM derived_meta WHERE layer = 'search'",
          )
          .get()?.status,
      ).toBe("degraded");
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("v10 graph missing dest_sensitivity is wiped on reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ledger-v10-dest-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const first = openLedger(path);
      initGraph(first);
      first.exec(`
        DROP TABLE graph_edges;
        CREATE TABLE graph_edges (
          src TEXT NOT NULL,
          dst TEXT NOT NULL,
          kind TEXT NOT NULL,
          sensitivity TEXT NOT NULL,
          taint TEXT NOT NULL CHECK (taint IN ('clean', 'quoted')),
          authority TEXT NOT NULL,
          provenance TEXT NOT NULL,
          PRIMARY KEY (src, dst, kind)
        ) STRICT;
        INSERT INTO graph_edges
          VALUES ('hub', 'secret', 'wikilink', 'public', 'clean', 'owner_authored', '[]');
      `);
      first.close();

      const reopened = openLedger(path);
      expect(schemaVersion(reopened)).toBe(15);
      expect(
        reopened
          .query<{ name: string }, [string]>(
            "SELECT name FROM pragma_table_info(?)",
          )
          .all("graph_edges")
          .map(({ name }) => name),
      ).toContain("dest_sensitivity");
      expect(neighbors(reopened, "hub")).toEqual({
        id: "hub",
        edges: [],
        truncated: false,
      });
      expect(
        reopened
          .query<{ status: string }, []>(
            "SELECT status FROM derived_meta WHERE layer = 'graph'",
          )
          .get()?.status,
      ).toBe("degraded");
      expect(
        reopened
          .query<{ status: string }, []>(
            "SELECT status FROM derived_meta WHERE layer = 'search'",
          )
          .get()?.status,
      ).toBeUndefined();
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
