import { Database } from "bun:sqlite";

interface Migration {
  version: number;
  sql: string;
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
      .query<SchemaVersionRow, []>(
        "SELECT version FROM schema_version LIMIT 1",
      )
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
      db.exec(migration.sql);
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
