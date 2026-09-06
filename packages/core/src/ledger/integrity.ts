import type { Database } from "bun:sqlite";
import { assertAgentEnrollmentSchema } from "../agents/enrollment-schema";
import { assertSourceSurvivorLineageSchema } from "./canon-source-survivor-lineage";
import { assertPurgeBatchSchema } from "./purge-batch-schema";
import { LedgerStoreError } from "./errors";
import { LEDGER_DOCTOR_ROW_CAP } from "./limits";
import { eventFromRow, type EventRow } from "./event-record";
import { isUlid } from "../util/ulid";
import { oneShotAll, oneShotGet, tableColumns, tableExists } from "./schema";

const REQUIRED_TABLES = [
  "schema_version",
  "events",
  "connections",
  "checkpoints",
  "rail_cursors",
] as const;

const EVENTS_COLUMNS = [
  "event_id",
  "connector_id",
  "source_record_id",
  "kind",
  "occurred_at",
  "observed_at",
  "text",
  "subjects",
  "sensitivity_hint",
  "deleted",
  "attachments",
  "metadata",
  "content_hash",
  "accepted_at",
  "content_hash_version",
  "text_hash",
  "origin",
  "origin_binding_version",
  "origin_binding_kind",
  "origin_binding",
] as const;

const EVENTS_INDEXES = [
  "events_accepted_order_idx",
  "events_connector_idx",
  "events_kind_idx",
  "events_occurred_idx",
] as const;

export interface LedgerHealthFailure {
  readonly kind:
    | "integrity"
    | "schema"
    | "schema_version"
    | "row"
    | "hash";
  readonly table: string;
  readonly detail: string;
}

export interface LedgerHealth {
  readonly ok: boolean;
  readonly schema_version: number | null;
  readonly quick_check: string;
  readonly integrity_check: string | null;
  readonly sampled_events: number;
  readonly failures: readonly LedgerHealthFailure[];
}

function tableSql(db: Database, name: string): string {
  return (
    oneShotGet<{ sql: string | null }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      name,
    )?.sql ?? ""
  );
}

function isStrict(db: Database, name: string): boolean {
  const row = oneShotGet<{ strict: number }>(
    db,
    "SELECT strict FROM pragma_table_list WHERE name = ?",
    name,
  );
  return row?.strict === 1;
}

function indexExists(db: Database, name: string): boolean {
  return (
    oneShotGet<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      name,
    ) !== null
  );
}

function schemaVersionRows(db: Database): { id: number | null; version: number }[] {
  if (!tableExists(db, "schema_version")) return [];
  const names = new Set(tableColumns(db, "schema_version"));
  if (names.has("id")) {
    return oneShotAll<{ id: number; version: number }>(
      db,
      "SELECT id, version FROM schema_version",
    );
  }
  return oneShotAll<{ version: number }>(db, "SELECT version FROM schema_version").map((row) => ({
    id: null,
    version: row.version,
  }));
}

export function readSchemaVersion(db: Database): number {
  const rows = schemaVersionRows(db);
  if (rows.length === 0) {
    throw new LedgerStoreError("corrupt", "schema_version is missing");
  }
  if (rows.length !== 1) {
    throw new LedgerStoreError("corrupt", "schema_version is not a singleton");
  }
  const row = rows[0];
  if (row === undefined || !Number.isInteger(row.version) || row.version < 0) {
    throw new LedgerStoreError("corrupt", "schema_version is not an integer");
  }
  if (row.id !== null && row.id !== 1) {
    throw new LedgerStoreError("corrupt", "schema_version id must be 1");
  }
  return row.version;
}

export function assertLedgerSchema(db: Database, expectedVersion: number): void {
  const version = readSchemaVersion(db);
  if (version !== expectedVersion) {
    throw new LedgerStoreError(
      "corrupt",
      `ledger schema version ${version} does not match ${expectedVersion}`,
    );
  }
  const missing = REQUIRED_TABLES.filter((name) => !tableExists(db, name));
  if (missing.length > 0) {
    throw new LedgerStoreError("corrupt", `ledger schema missing tables: ${missing.join(",")}`);
  }
  if (!isStrict(db, "events")) {
    throw new LedgerStoreError("corrupt", "events is not STRICT");
  }
  if (!isStrict(db, "schema_version")) {
    throw new LedgerStoreError("corrupt", "schema_version is not STRICT");
  }
  const eventColumns = tableColumns(db, "events");
  if (EVENTS_COLUMNS.some((name, index) => eventColumns[index] !== name)) {
    throw new LedgerStoreError("corrupt", "events columns do not match schema");
  }
  const sql = tableSql(db, "events");
  if (!sql.includes("CHECK") || !sql.includes("deleted IN (0, 1)")) {
    throw new LedgerStoreError("corrupt", "events is missing fail-closed CHECKs");
  }
  const missingIndexes = EVENTS_INDEXES.filter((name) => !indexExists(db, name));
  if (missingIndexes.length > 0) {
    throw new LedgerStoreError(
      "corrupt",
      `ledger schema missing indexes: ${missingIndexes.join(",")}`,
    );
  }
  const checkpointSql = tableSql(db, "checkpoints");
  if (!checkpointSql.includes("REFERENCES connections")) {
    throw new LedgerStoreError("corrupt", "checkpoints lack a connections foreign key");
  }
  if (expectedVersion >= 18) assertAgentEnrollmentSchema(db);
  if (expectedVersion >= 19) assertPurgeBatchSchema(db);
  if (expectedVersion >= 20) assertSourceSurvivorLineageSchema(db);
}

function boundedCheck(db: Database, pragma: "quick_check" | "integrity_check"): string {
  const rows = db.query<Record<string, string>, []>(`PRAGMA ${pragma}`).all();
  const values = rows.flatMap((row) => Object.values(row));
  if (values.length === 1 && values[0] === "ok") return "ok";
  return values.join("; ") || "failed";
}

function sampleEventRows(db: Database): EventRow[] {
  return oneShotAll<EventRow>(
    db,
    `
      SELECT event_id, connector_id, source_record_id, kind,
             occurred_at, observed_at, text, subjects, sensitivity_hint,
             deleted, attachments, metadata, content_hash, accepted_at,
             content_hash_version, text_hash, origin, origin_binding_version,
             origin_binding_kind, origin_binding
        FROM events
       ORDER BY accepted_at, event_id
       LIMIT ?
    `,
    LEDGER_DOCTOR_ROW_CAP,
  );
}

export function inspectLedgerHealth(
  db: Database,
  opts: { full?: boolean; expectedVersion: number },
): LedgerHealth {
  const failures: LedgerHealthFailure[] = [];
  let schemaVersion: number | null = null;
  try {
    schemaVersion = readSchemaVersion(db);
  } catch (error) {
    failures.push({
      kind: "schema_version",
      table: "schema_version",
      detail: error instanceof Error ? error.message : "unreadable",
    });
  }

  const quick = boundedCheck(db, "quick_check");
  if (quick !== "ok") {
    failures.push({ kind: "integrity", table: "sqlite", detail: "quick_check failed" });
  }
  const full = opts.full === true ? boundedCheck(db, "integrity_check") : null;
  if (full !== null && full !== "ok") {
    failures.push({ kind: "integrity", table: "sqlite", detail: "integrity_check failed" });
  }

  if (schemaVersion !== null) {
    try {
      assertLedgerSchema(db, opts.expectedVersion);
    } catch (error) {
      failures.push({
        kind: "schema",
        table: "events",
        detail: error instanceof Error ? error.message : "schema mismatch",
      });
    }
  }

  let sampled = 0;
  if (tableExists(db, "events")) {
    let rows: EventRow[] = [];
    try {
      rows = sampleEventRows(db);
    } catch {
      failures.push({ kind: "row", table: "events", detail: "event sample could not be read" });
    }
    sampled = rows.length;
    for (const row of rows) {
      try {
        eventFromRow(row, db);
      } catch {
        const eventId = typeof row.event_id === "string" && isUlid(row.event_id) ? row.event_id : "invalid";
        failures.push({
          kind: "row",
          table: "events",
          detail: `event_id ${eventId}: event record failed integrity validation`,
        });
      }
    }
  }

  return {
    ok: failures.length === 0,
    schema_version: schemaVersion,
    quick_check: quick,
    integrity_check: full,
    sampled_events: sampled,
    failures,
  };
}
