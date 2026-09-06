import type { Database } from "bun:sqlite";
import { MAX_CURSOR_BYTES } from "../contracts/connector";
import type { RunResult } from "../ingest/run";
import { isPlainObject } from "../util/validate";
import { isUlid } from "../util/ulid";

export interface Connection {
  connector_id: string;
  source_key: string;
  config: ConnectionConfig;
  secret_refs: string[];
  connected_at: string;
  disconnected_at: string | null;
  implementation_version: string;
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

export type ConnectionRunStatus = "ok" | "failed" | "unavailable" | "refused";

export interface ConnectionRun {
  run_id: string;
  connector_id: string;
  source_key: string;
  mode: "backfill" | "sync";
  started_at: string;
  finished_at: string;
  previous_cursor: string | null;
  attempted_cursor: string | null;
  committed_cursor: string | null;
  stored: number;
  duplicates: number;
  errors: string[];
  status: ConnectionRunStatus;
}

export type Inspected<T> =
  | { ok: true; value: T }
  | { ok: false; connector_id: string; source_key: string; error: string };

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
  implementation_version: string;
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

interface ConnectionRunRow {
  run_id: string;
  connector_id: string;
  source_key: string;
  mode: string;
  started_at: string;
  finished_at: string;
  previous_cursor: string | null;
  attempted_cursor: string | null;
  committed_cursor: string | null;
  stored: number;
  duplicates: number;
  errors: string;
  status: string;
}

const NULL_CONFIG = '{"schema":"kizuki.connection-config/v1","state_ref_index":null}';
const STATE_CONFIG = '{"schema":"kizuki.connection-config/v1","state_ref_index":0}';

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
  if (!isUlid(row.source_key)) {
    throw new LedgerError("connection source_key is not core-generated");
  }
  if (typeof row.implementation_version !== "string") {
    throw new LedgerError("connection implementation_version is invalid");
  }
  const refs = stringArray(row.secret_refs, "secret_refs");
  return {
    connector_id: row.connector_id,
    source_key: row.source_key,
    config: configFromRow(row.config, refs, row.source_key),
    secret_refs: refs,
    connected_at: row.connected_at,
    disconnected_at: row.disconnected_at,
    implementation_version: row.implementation_version,
  };
}

function finiteCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new LedgerError(`checkpoint last_result.${field} is not a finite count`);
  }
  return value;
}

function decodeCursor(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new LedgerError(`${field} is not a cursor`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_CURSOR_BYTES) {
    throw new LedgerError(`${field} exceeds maximum cursor size`);
  }
  return value;
}

export function assertCursorSize(cursor: string | null, field = "cursor"): string | null {
  return decodeCursor(cursor, field);
}

function runResultFromUnknown(value: unknown): RunResult {
  if (!isPlainObject(value)) {
    throw new LedgerError("checkpoint last_result is not an object");
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "cursor",
    "duplicates",
    "errors",
    "proposals_created",
    "retractions_filed",
    "stored",
    "withdrawn",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new LedgerError("checkpoint last_result has unexpected keys");
  }
  if (!Array.isArray(value.errors) || !value.errors.every((item) => typeof item === "string")) {
    throw new LedgerError("checkpoint last_result.errors is not a string array");
  }
  return {
    stored: finiteCount(value.stored, "stored"),
    duplicates: finiteCount(value.duplicates, "duplicates"),
    errors: value.errors,
    proposals_created: finiteCount(value.proposals_created, "proposals_created"),
    withdrawn: finiteCount(value.withdrawn, "withdrawn"),
    retractions_filed: finiteCount(value.retractions_filed, "retractions_filed"),
    cursor: decodeCursor(value.cursor, "last_result.cursor"),
  };
}

function checkpointFromRow(row: CheckpointRow): Checkpoint {
  if (row.mode !== "backfill" && row.mode !== "sync") {
    throw new LedgerError(`checkpoint mode is invalid: ${row.mode}`);
  }
  const last_result = runResultFromUnknown(JSON.parse(row.last_result));
  const cursor = decodeCursor(row.cursor, "cursor");
  if (cursor !== last_result.cursor) {
    throw new LedgerError("checkpoint cursor does not match last_result.cursor");
  }
  return {
    connector_id: row.connector_id,
    source_key: row.source_key,
    cursor,
    mode: row.mode,
    updated_at: row.updated_at,
    last_run_at: row.last_run_at,
    last_result,
  };
}

function inspectRow<T>(
  connector_id: string,
  source_key: string,
  decode: () => T,
): Inspected<T> {
  try {
    return { ok: true, value: decode() };
  } catch (error) {
    return {
      ok: false,
      connector_id,
      source_key,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

export function inspectConnections(
  db: Database,
  opts: { includeDisconnected?: boolean } = {},
): Inspected<Connection>[] {
  const rows = opts.includeDisconnected === true
    ? db.query<ConnectionRow, []>("SELECT * FROM connections ORDER BY connector_id, source_key").all()
    : db
        .query<ConnectionRow, []>(
          "SELECT * FROM connections WHERE disconnected_at IS NULL ORDER BY connector_id, source_key",
        )
        .all();
  return rows.map((row) =>
    inspectRow(row.connector_id, row.source_key, () => connectionFromRow(row)),
  );
}

export function listConnections(
  db: Database,
  opts: { includeDisconnected?: boolean } = {},
): Connection[] {
  return inspectConnections(db, opts).flatMap((item) => (item.ok ? [item.value] : []));
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

export function requireActiveConnection(
  db: Database,
  connector_id: string,
  source_key: string,
): Connection {
  const connection = getConnection(db, connector_id, source_key);
  if (connection === null) {
    throw new LedgerError("checkpoint requires an active connection");
  }
  if (connection.disconnected_at !== null) {
    throw new LedgerError("checkpoint requires an active connection");
  }
  return connection;
}

/**
 * Persist a null-state connection the host already decided to enroll.
 * Interactive sign-in goes through ConnectionStateStore; this is the row
 * a fixture or none-auth host writes so ingest has something to bind to.
 */
export function registerConnection(
  db: Database,
  connector_id: string,
  source_key: string,
  options?: { implementation_version?: string },
): Connection {
  if (typeof connector_id !== "string" || connector_id.length === 0) {
    throw new LedgerError("connector_id is required");
  }
  if (!isUlid(source_key)) {
    throw new LedgerError("connection source_key is not core-generated");
  }
  const version = options?.implementation_version ?? "";
  db.query(
    `INSERT INTO connections
       (connector_id, source_key, config, secret_refs, connected_at, disconnected_at, implementation_version, consent_required)
     VALUES (?, ?, ?, '[]', ?, NULL, ?, 1)`,
  ).run(connector_id, source_key, NULL_CONFIG, new Date().toISOString(), version);
  const connection = getConnection(db, connector_id, source_key);
  if (connection === null) throw new LedgerError("registered connection was not found");
  return connection;
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

export function inspectCheckpoints(db: Database): Inspected<Checkpoint>[] {
  return db
    .query<CheckpointRow, []>(
      "SELECT * FROM checkpoints ORDER BY connector_id, source_key",
    )
    .all()
    .map((row) => inspectRow(row.connector_id, row.source_key, () => checkpointFromRow(row)));
}

export function listCheckpoints(db: Database): Checkpoint[] {
  return inspectCheckpoints(db).flatMap((item) => (item.ok ? [item.value] : []));
}

export function listConnectionRuns(
  db: Database,
  connector_id: string,
  source_key: string,
): ConnectionRun[] {
  return db
    .query<ConnectionRunRow, [string, string]>(
      `SELECT * FROM connection_runs
        WHERE connector_id = ? AND source_key = ?
        ORDER BY finished_at, run_id`,
    )
    .all(connector_id, source_key)
    .map((row) => {
      if (row.mode !== "backfill" && row.mode !== "sync") {
        throw new LedgerError(`connection run mode is invalid: ${row.mode}`);
      }
      if (
        row.status !== "ok" &&
        row.status !== "failed" &&
        row.status !== "unavailable" &&
        row.status !== "refused"
      ) {
        throw new LedgerError(`connection run status is invalid: ${row.status}`);
      }
      return {
        run_id: row.run_id,
        connector_id: row.connector_id,
        source_key: row.source_key,
        mode: row.mode,
        started_at: row.started_at,
        finished_at: row.finished_at,
        previous_cursor: row.previous_cursor,
        attempted_cursor: row.attempted_cursor,
        committed_cursor: row.committed_cursor,
        stored: row.stored,
        duplicates: row.duplicates,
        errors: stringArray(row.errors, "connection_runs.errors"),
        status: row.status,
      };
    });
}
