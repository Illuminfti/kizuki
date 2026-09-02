import { Database } from "bun:sqlite";
import { applyClaimsV3 } from "../claims/schema";

interface Migration {
  version: number;
  sql?: string;
  apply?: (db: Database) => void;
}

interface SchemaVersionRow {
  version: number;
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
];

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version(version)
      SELECT 0
      WHERE NOT EXISTS (SELECT 1 FROM schema_version);
  `);

  const current =
    db
      .query<SchemaVersionRow, []>("SELECT version FROM schema_version LIMIT 1")
      .get()?.version ?? 0;
  const latest = MIGRATIONS.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(
      `ledger schema version ${current} is newer than supported version ${latest}`,
    );
  }

  const pending = MIGRATIONS.filter(({ version }) => version > current);
  if (pending.length === 0) return;

  db.transaction(() => {
    for (const migration of pending) {
      if (migration.sql !== undefined) db.exec(migration.sql);
      migration.apply?.(db);
      db.query<never, [number]>("UPDATE schema_version SET version = ?").run(
        migration.version,
      );
    }
  }).immediate();
}

export function openLedger(dbPath: string): Database {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
