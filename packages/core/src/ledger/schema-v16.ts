import type { Database } from "bun:sqlite";
import { installEventIdentityGuards } from "./event-identity-schema";
import { oneShotAll, oneShotGet, oneShotRun, tableColumns, tableExists } from "./schema";

const ULID_CHECK = `length(event_id) = 26 AND event_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'`;
const HASH_CHECK = `length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'`;
const STAMP_CHECK = `(
  length(col) BETWEEN 20 AND 40
  AND col GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][Tt][0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
)`;

function stampCheck(column: string): string {
  return STAMP_CHECK.replaceAll("col", column);
}

const EVENTS_V16 = `
CREATE TABLE events_v16 (
  event_id TEXT PRIMARY KEY CHECK (${ULID_CHECK}),
  connector_id TEXT NOT NULL CHECK (length(connector_id) BETWEEN 1 AND 128),
  source_record_id TEXT NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 128),
  occurred_at TEXT NOT NULL CHECK (${stampCheck("occurred_at")}),
  observed_at TEXT NOT NULL CHECK (${stampCheck("observed_at")}),
  text TEXT NOT NULL,
  subjects TEXT NOT NULL CHECK (json_valid(subjects) AND json_type(subjects) = 'array'),
  sensitivity_hint TEXT CHECK (
    sensitivity_hint IS NULL
    OR sensitivity_hint IN ('public', 'personal', 'private')
  ),
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  attachments TEXT NOT NULL CHECK (json_valid(attachments) AND json_type(attachments) = 'array'),
  metadata TEXT NOT NULL CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  content_hash TEXT NOT NULL CHECK (${HASH_CHECK}),
  accepted_at TEXT NOT NULL CHECK (${stampCheck("accepted_at")}),
  content_hash_version INTEGER NOT NULL DEFAULT 0,
  text_hash TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'external' CHECK (origin IN ('external', 'self')),
  origin_binding_version INTEGER NOT NULL DEFAULT 0,
  origin_binding_kind TEXT NOT NULL DEFAULT '',
  origin_binding TEXT NOT NULL DEFAULT '',
  UNIQUE(connector_id, source_record_id, content_hash)
) STRICT;
`;

const SCHEMA_VERSION_V16 = `
CREATE TABLE schema_version_v16 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version >= 0)
) STRICT;
`;

const RAIL_CURSORS = `
CREATE TABLE IF NOT EXISTS rail_cursors (
  rail TEXT NOT NULL CHECK (length(rail) BETWEEN 1 AND 128),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 128),
  cursor TEXT NOT NULL CHECK (length(cursor) BETWEEN 1 AND 8192),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (rail, source_key)
) STRICT;
`;

const CHECKPOINTS_V16 = `
CREATE TABLE checkpoints_v16 (
  connector_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  cursor TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('backfill', 'sync')),
  updated_at TEXT NOT NULL,
  last_run_at TEXT NOT NULL,
  last_result TEXT NOT NULL CHECK (json_valid(last_result) AND json_type(last_result) = 'object'),
  PRIMARY KEY (connector_id, source_key),
  FOREIGN KEY (connector_id, source_key)
    REFERENCES connections(connector_id, source_key)
) STRICT;
`;

function rebuildSchemaVersion(db: Database): void {
  const columns = tableExists(db, "schema_version")
    ? new Set(tableColumns(db, "schema_version"))
    : new Set<string>();
  if (columns.has("id") && columns.has("version")) return;

  const version =
    oneShotGet<{ version: number }>(db, "SELECT version FROM schema_version")?.version ?? 0;
  db.exec(SCHEMA_VERSION_V16);
  oneShotRun(db, "INSERT INTO schema_version_v16(id, version) VALUES (1, ?)", version);
  db.exec("DROP TABLE schema_version");
  db.exec("ALTER TABLE schema_version_v16 RENAME TO schema_version");
}

interface DeferredInputSnapshot {
  event_id: string;
  source_key: string | null;
  checked_revision: number;
  checked_binding_digest: string;
}

function snapshotDeferredInputs(db: Database): DeferredInputSnapshot[] {
  if (!tableExists(db, "extract_deferred_inputs")) return [];
  return oneShotAll<DeferredInputSnapshot>(
    db,
    "SELECT event_id, source_key, checked_revision, checked_binding_digest FROM extract_deferred_inputs",
  );
}

function restoreDeferredInputs(db: Database, rows: DeferredInputSnapshot[]): void {
  for (const row of rows) {
    oneShotRun(
      db,
      `INSERT INTO extract_deferred_inputs
        (event_id, source_key, checked_revision, checked_binding_digest)
       VALUES (?, ?, ?, ?)`,
      row.event_id,
      row.source_key,
      row.checked_revision,
      row.checked_binding_digest,
    );
  }
}

function rebuildEvents(db: Database): void {
  const deferred = snapshotDeferredInputs(db);
  db.exec(EVENTS_V16);
  db.exec(`
    INSERT INTO events_v16 (
      event_id, connector_id, source_record_id, kind,
      occurred_at, observed_at, text, subjects, sensitivity_hint,
      deleted, attachments, metadata, content_hash, accepted_at,
      content_hash_version, text_hash, origin,
      origin_binding_version, origin_binding_kind, origin_binding
    )
    SELECT
      event_id, connector_id, source_record_id, kind,
      occurred_at, observed_at, text, subjects, sensitivity_hint,
      deleted, attachments, metadata, content_hash, accepted_at,
      content_hash_version, text_hash, origin,
      origin_binding_version, origin_binding_kind, origin_binding
    FROM events
  `);
  db.exec("DROP TABLE events");
  db.exec("ALTER TABLE events_v16 RENAME TO events");
  db.exec(`
    CREATE INDEX events_accepted_order_idx ON events(accepted_at, event_id);
    CREATE INDEX events_connector_idx ON events(connector_id);
    CREATE INDEX events_kind_idx ON events(kind);
    CREATE INDEX events_occurred_idx ON events(occurred_at, event_id);
  `);
  db.exec(`
    DROP TRIGGER IF EXISTS events_identity_insert;
    DROP TRIGGER IF EXISTS events_identity_update;
    DROP TRIGGER IF EXISTS native_owner_hash_insert;
    DROP TRIGGER IF EXISTS native_owner_hash_update;
  `);
  installEventIdentityGuards(db);
  restoreDeferredInputs(db, deferred);
}

function moveExtractCheckpoints(db: Database): void {
  db.exec(RAIL_CURSORS);
  if (!tableExists(db, "checkpoints")) return;
  db.exec(`
    INSERT INTO rail_cursors (rail, source_key, cursor, updated_at)
    SELECT connector_id, source_key, cursor, updated_at
      FROM checkpoints
     WHERE cursor IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM connections c
          WHERE c.connector_id = checkpoints.connector_id
            AND c.source_key = checkpoints.source_key
       )
    ON CONFLICT (rail, source_key) DO UPDATE SET
      cursor = excluded.cursor,
      updated_at = excluded.updated_at
  `);
  db.exec(`
    DELETE FROM checkpoints
     WHERE NOT EXISTS (
       SELECT 1 FROM connections c
        WHERE c.connector_id = checkpoints.connector_id
          AND c.source_key = checkpoints.source_key
     )
  `);
}

function rebuildCheckpoints(db: Database): void {
  if (!tableExists(db, "checkpoints")) return;
  const sql =
    oneShotGet<{ sql: string | null }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      "checkpoints",
    )?.sql ?? "";
  if (sql.includes("REFERENCES connections")) return;

  db.exec(CHECKPOINTS_V16);
  db.exec(`
    INSERT INTO checkpoints_v16
    SELECT connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result
      FROM checkpoints
  `);
  db.exec("DROP TABLE checkpoints");
  db.exec("ALTER TABLE checkpoints_v16 RENAME TO checkpoints");
}

/**
 * Ledger v17: STRICT events that keep v16 identity columns, singleton
 * schema_version, connection FKs, and extract tokens in rail_cursors.
 * agent_audit is not keyed to agents: owner rows use the reserved id
 * `owner`, which is not an agents row.
 */
export function applyLedgerV16(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON");
  rebuildSchemaVersion(db);
  rebuildEvents(db);
  moveExtractCheckpoints(db);
  rebuildCheckpoints(db);
}
