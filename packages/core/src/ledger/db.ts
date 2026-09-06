import { Database } from "bun:sqlite";
import { applySourceGrantsV11, applyNativeOwnerEvidenceV12, applySourceStoresV13, applySourceErasureV14, applySourceReceiptIntegrityV15 } from "./source-grants-schema";
import { applyAgentsV9 } from "../agents/schema";
import { applyCanonV4, initCanon } from "../canon/schema";
import { applyClaimsV3 } from "../claims/schema";
import { applyDerivedV10 } from "../derived";
import { applyServeV7, initServe } from "../serve/schema";
import { applySensitivityV6 } from "../sensitivity/schema";
import { applyConnectionsV8 } from "./connections-schema";
import { LedgerStoreError } from "./errors";
import {
  assertLedgerSchema,
  inspectLedgerHealth,
  readSchemaVersion,
} from "./integrity";
import type { LedgerHealth } from "./integrity";
import { LEDGER_BUSY_TIMEOUT_MS } from "./limits";
import { applyPurgeV5 } from "./purge-schema";
import { applyPurgeBatchesV19 } from "./purge-batch-schema";
import { applyEventIdentityV16 } from "./event-identity-schema";
import { applyAgentEnrollmentV18 } from "../agents/enrollment-schema";
import { applySourceSurvivorLineageV20 } from "./canon-source-survivor-lineage";
import { oneShotAll, oneShotRun, tableColumns, tableExists } from "./schema";
import { applyLedgerV16 } from "./schema-v16";

interface Migration {
  version: number;
  sql?: string;
  apply?: (db: Database) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
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

      CREATE INDEX events_accepted_order_idx
        ON events(accepted_at, event_id);
      CREATE INDEX events_connector_idx ON events(connector_id);
      CREATE INDEX events_kind_idx ON events(kind);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE connections (
        connector_id TEXT NOT NULL,
        source_key TEXT NOT NULL CHECK (
          length(source_key) = 26
          AND source_key NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
        ),
        config TEXT NOT NULL CHECK (
          config = '{"schema":"kizuki.connection-config/v1","state_ref_index":null}'
          OR config = '{"schema":"kizuki.connection-config/v1","state_ref_index":0}'
        ),
        secret_refs TEXT NOT NULL CHECK (
          (config = '{"schema":"kizuki.connection-config/v1","state_ref_index":null}' AND secret_refs = '[]')
          OR (
            config = '{"schema":"kizuki.connection-config/v1","state_ref_index":0}'
            AND secret_refs = '["file:connections/' || source_key || '.state"]'
          )
        ),
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

      CREATE TABLE IF NOT EXISTS promotions (
        receipt_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE,
        provenance TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        page_path TEXT NOT NULL,
        page_hash TEXT NOT NULL,
        at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE promotions_v2 (
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

      INSERT INTO promotions_v2 (
        receipt_id, proposal_id, provenance, sensitivity, page_path,
        kind, before_hash, after_hash, at
      )
      SELECT receipt_id, proposal_id, provenance, sensitivity, page_path,
             'claim', NULL, page_hash, at
        FROM promotions;

      DROP TABLE promotions;
      ALTER TABLE promotions_v2 RENAME TO promotions;
    `,
  },
  {
    version: 3,
    apply: applyClaimsV3,
  },
  {
    version: 4,
    apply: applyCanonV4,
  },
  {
    version: 5,
    apply: applyPurgeV5,
  },
  {
    version: 6,
    apply: applySensitivityV6,
  },
  {
    version: 7,
    apply: applyServeV7,
  },
  {
    version: 8,
    apply: applyConnectionsV8,
  },
  {
    version: 9,
    apply: applyAgentsV9,
  },
  {
    version: 10,
    apply: applyDerivedV10,
  },
  { version: 11, apply: applySourceGrantsV11 },
  { version: 12, apply: applyNativeOwnerEvidenceV12 },
  { version: 13, apply: applySourceStoresV13 },
  { version: 14, apply: applySourceErasureV14 },
  { version: 15, apply: applySourceReceiptIntegrityV15 },
  { version: 16, apply: applyEventIdentityV16 },
  { version: 17, apply: applyLedgerV16 },
  { version: 18, apply: applyAgentEnrollmentV18 },
  { version: 19, apply: applyPurgeBatchesV19 },
  { version: 20, apply: applySourceSurvivorLineageV20 },
];

export const LEDGER_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

function schemaVersionHasId(db: Database): boolean {
  return tableColumns(db, "schema_version").includes("id");
}

function insertVersion(db: Database, version: number): void {
  if (schemaVersionHasId(db)) {
    oneShotRun(db, "INSERT INTO schema_version(id, version) VALUES (1, ?)", version);
    return;
  }
  oneShotRun(db, "INSERT INTO schema_version(version) VALUES (?)", version);
}

function repairSchemaVersion(db: Database): void {
  if (!tableExists(db, "schema_version")) {
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL CHECK (version >= 0)
      ) STRICT;
    `);
    insertVersion(db, 0);
    return;
  }

  const rows = oneShotAll<{ version: number }>(db, "SELECT version FROM schema_version");
  if (rows.length === 0) {
    insertVersion(db, 0);
    return;
  }
  const versions = [...new Set(rows.map((row) => row.version))];
  if (versions.length !== 1) {
    throw new LedgerStoreError("corrupt", "schema_version has conflicting values");
  }
  const version = versions[0];
  if (version === undefined || !Number.isInteger(version) || version < 0) {
    throw new LedgerStoreError("corrupt", "schema_version is not an integer");
  }
  if (rows.length > 1) {
    db.exec("DELETE FROM schema_version");
    insertVersion(db, version);
  }
}

function writeSchemaVersion(db: Database, version: number): void {
  oneShotRun(db, "UPDATE schema_version SET version = ?", version);
}

function migrate(db: Database): void {
  repairSchemaVersion(db);
  const current = readSchemaVersion(db);
  const latest = LEDGER_SCHEMA_VERSION;
  if (current > latest) {
    throw new LedgerStoreError(
      "corrupt",
      `ledger schema version ${current} is newer than supported version ${latest}`,
    );
  }

  const pending = MIGRATIONS.filter(({ version }) => version > current);
  if (pending.length === 0) {
    db.transaction(() => {
      applyDerivedV10(db);
    }).immediate();
    assertLedgerSchema(db, latest);
    return;
  }

  db.transaction(() => {
    for (const migration of pending) {
      if (migration.sql !== undefined) db.exec(migration.sql);
      migration.apply?.(db);
      writeSchemaVersion(db, migration.version);
    }
  }).immediate();
  assertLedgerSchema(db, latest);
}

export function openLedger(dbPath: string, options: { busyTimeoutMs?: number } = {}): Database {
  const timeout = options.busyTimeoutMs ?? LEDGER_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5000) throw new TypeError("invalid ledger busy timeout");
  const db = new Database(dbPath);
  try {
    // Apply before migrations: concurrent process startup is a writer too.
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    initServe(db);
    initCanon(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function inspectOpenLedgerHealth(
  db: Database,
  opts: { full?: boolean } = {},
): LedgerHealth {
  return inspectLedgerHealth(db, {
    ...(opts.full === undefined ? {} : { full: opts.full }),
    expectedVersion: LEDGER_SCHEMA_VERSION,
  });
}
