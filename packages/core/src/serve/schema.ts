import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import {
  DEFAULT_RAILS,
  SERVE_SCHEMA_VERSION,
  type RailId,
  type ScheduleRow,
} from "./types";

/**
 * RFC 0002 §18.1 listed these tables under v5 with purge_ops. Purge-totality
 * shipped `purge_ops` as sequential v5 and sensitivity shipped v6, so the
 * remaining daemon tables land as v7. `retrieval_ops` already exists from
 * claims-core and is not recreated here.
 */
export { SERVE_SCHEMA_VERSION };

const TABLES = `
CREATE TABLE IF NOT EXISTS schedules (
  rail TEXT PRIMARY KEY,
  period_s INTEGER NOT NULL,
  jitter_s INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS run_receipts (
  run_id TEXT PRIMARY KEY,
  rail TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL,
  stopped TEXT,
  report TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS run_receipts_rail_finished
  ON run_receipts(rail, finished_at);
CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY,
  holder_pid INTEGER NOT NULL,
  holder_boot_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  ttl_s INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS budget_ledger (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  used REAL NOT NULL,
  PRIMARY KEY (day, name)
) STRICT;
CREATE TABLE IF NOT EXISTS extract_batches (
  previous_cursor TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  drafts TEXT NOT NULL,
  model_ref TEXT,
  created_at TEXT NOT NULL
) STRICT;
`;

export function applyServeV7(db: Database): void {
  db.exec(TABLES);
  seedSchedules(db);
}

export function initServe(db: Database): void {
  if (!tableExists(db, "schedules")) {
    applyServeV7(db);
    return;
  }
  // v7 shipped before the durable extraction-output journal.  It is an
  // additive table, so install it for existing vaults without re-running a
  // destructive schema migration.
  db.exec(`CREATE TABLE IF NOT EXISTS extract_batches (
    previous_cursor TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    drafts TEXT NOT NULL,
    model_ref TEXT,
    created_at TEXT NOT NULL
  ) STRICT;`);
  seedSchedules(db);
}

export function seedSchedules(db: Database): void {
  const insert = db.query(
    `INSERT OR IGNORE INTO schedules (rail, period_s, jitter_s, enabled)
     VALUES (?, ?, ?, 1)`,
  );
  for (const spec of DEFAULT_RAILS) {
    insert.run(spec.rail, spec.period_s, spec.jitter_s);
  }
}

export function listSchedules(db: Database): ScheduleRow[] {
  if (!tableExists(db, "schedules")) return [];
  return db
    .query<
      {
        rail: string;
        period_s: number;
        jitter_s: number;
        enabled: number;
        last_run_at: string | null;
        next_run_at: string | null;
      },
      []
    >(
      `SELECT rail, period_s, jitter_s, enabled, last_run_at, next_run_at
         FROM schedules
        ORDER BY rail`,
    )
    .all()
    .filter((row): row is typeof row & { rail: RailId } =>
      DEFAULT_RAILS.some((spec) => spec.rail === row.rail),
    )
    .map((row) => ({
      rail: row.rail,
      period_s: row.period_s,
      jitter_s: row.jitter_s,
      enabled: row.enabled === 1,
      last_run_at: row.last_run_at,
      next_run_at: row.next_run_at,
    }));
}

export function markScheduleRun(
  db: Database,
  rail: RailId,
  finishedAt: string,
  nextRunAt: string,
): void {
  db.query(
    `UPDATE schedules
        SET last_run_at = ?, next_run_at = ?
      WHERE rail = ?`,
  ).run(finishedAt, nextRunAt, rail);
}
