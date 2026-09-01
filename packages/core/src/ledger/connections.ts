import type { Database } from "bun:sqlite";
import type { RunResult } from "../ingest/run";

export interface Connection {
  connector_id: string;
  source_key: string;
  config: ConnectionConfig;
  secret_refs: string[];
  connected_at: string;
  disconnected_at: string | null;
}

export interface ConnectionConfig {
  schema: "kizuki.connection-config/v1";
  state_ref_index: null | 0;
}

export interface Checkpoint {
  connector_id: string;
  source_key: string;
  cursor: string | null;
  mode: "backfill" | "sync";
  updated_at: string;
  last_run_at: string;
  last_result: RunResult;
}

export class LedgerError extends Error {
  override name = "LedgerError";
}

interface ConnectionRow {
  connector_id: string;
  source_key: string;
  config: string;
  secret_refs: string;
  connected_at: string;
  disconnected_at: string | null;
}

interface CheckpointRow {
  connector_id: string;
  source_key: string;
  cursor: string | null;
  mode: string;
  updated_at: string;
  last_run_at: string;
  last_result: string;
}

const NULL_CONFIG = '{"schema":"kizuki.connection-config/v1","state_ref_index":null}';
const STATE_CONFIG = '{"schema":"kizuki.connection-config/v1","state_ref_index":0}';
const CORE_ULID = /^[0-9A-HJKMNPQRSTVWXYZ]{26}$/;

function stringArray(raw: string, field: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new LedgerError(`${field}: stored value is not a string array`);
  }
  return parsed;
}

function configFromRow(raw: string, refs: string[], sourceKey: string): ConnectionConfig {
  if (raw === NULL_CONFIG && refs.length === 0) {
    return { schema: "kizuki.connection-config/v1", state_ref_index: null };
  }
  const expected = `file:connections/${sourceKey}.state`;
  if (raw === STATE_CONFIG && refs.length === 1 && refs[0] === expected) {
    return { schema: "kizuki.connection-config/v1", state_ref_index: 0 };
  }
  throw new LedgerError("connection row violates the opaque-state contract");
}

function connectionFromRow(row: ConnectionRow): Connection {
  if (!CORE_ULID.test(row.source_key)) {
    throw new LedgerError("connection source_key is not core-generated");
  }
  const refs = stringArray(row.secret_refs, "secret_refs");
  return {
    connector_id: row.connector_id,
    source_key: row.source_key,
    config: configFromRow(row.config, refs, row.source_key),
    secret_refs: refs,
    connected_at: row.connected_at,
    disconnected_at: row.disconnected_at,
  };
}

function checkpointFromRow(row: CheckpointRow): Checkpoint {
  if (row.mode !== "backfill" && row.mode !== "sync") {
    throw new LedgerError(`checkpoint mode is invalid: ${row.mode}`);
  }
  return {
    connector_id: row.connector_id,
    source_key: row.source_key,
    cursor: row.cursor,
    mode: row.mode,
    updated_at: row.updated_at,
    last_run_at: row.last_run_at,
    last_result: JSON.parse(row.last_result) as RunResult,
  };
}

export function getConnection(
  db: Database,
  connector_id: string,
  source_key: string,
): Connection | null {
  const row = db
    .query<ConnectionRow, [string, string]>(
      "SELECT * FROM connections WHERE connector_id = ? AND source_key = ?",
    )
    .get(connector_id, source_key);
  return row === null ? null : connectionFromRow(row);
}

export function listConnections(
  db: Database,
  opts: { includeDisconnected?: boolean } = {},
): Connection[] {
  const rows = opts.includeDisconnected === true
    ? db.query<ConnectionRow, []>("SELECT * FROM connections ORDER BY connector_id, source_key").all()
    : db
        .query<ConnectionRow, []>(
          "SELECT * FROM connections WHERE disconnected_at IS NULL ORDER BY connector_id, source_key",
        )
        .all();
  return rows.map(connectionFromRow);
}

export function disconnect(
  db: Database,
  connector_id: string,
  source_key: string,
): void {
  db.query(
    "UPDATE connections SET disconnected_at = ? WHERE connector_id = ? AND source_key = ?",
  ).run(new Date().toISOString(), connector_id, source_key);
}

export function saveCheckpoint(
  db: Database,
  connector_id: string,
  source_key: string,
  cursor: string | null,
  mode: "backfill" | "sync",
  result: RunResult,
): Checkpoint {
  const at = new Date().toISOString();
  db.query(
    `INSERT INTO checkpoints
       (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (connector_id, source_key) DO UPDATE SET
       cursor = excluded.cursor,
       mode = excluded.mode,
       updated_at = excluded.updated_at,
       last_run_at = excluded.last_run_at,
       last_result = excluded.last_result`,
  ).run(connector_id, source_key, cursor, mode, at, at, JSON.stringify(result));
  const checkpoint = getCheckpoint(db, connector_id, source_key);
  if (checkpoint === null) throw new LedgerError("saved checkpoint was not found");
  return checkpoint;
}

export function getCheckpoint(
  db: Database,
  connector_id: string,
  source_key: string,
): Checkpoint | null {
  const row = db
    .query<CheckpointRow, [string, string]>(
      "SELECT * FROM checkpoints WHERE connector_id = ? AND source_key = ?",
    )
    .get(connector_id, source_key);
  return row === null ? null : checkpointFromRow(row);
}

export function listCheckpoints(db: Database): Checkpoint[] {
  return db
    .query<CheckpointRow, []>(
      "SELECT * FROM checkpoints ORDER BY connector_id, source_key",
    )
    .all()
    .map(checkpointFromRow);
}
