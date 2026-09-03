import type { Database } from "bun:sqlite";
import { tableExists } from "./schema";

/**
 * RFC 0002 §18.1 v5 fragment owned by purge-totality: `purge_ops` only.
 * Schedules, leases, budgets and retrieval_ops stay with serve-daemon.
 */
export const PURGE_SCHEMA_VERSION = 5;

export const PURGE_SLA_SECONDS = 3600;

const PURGE_OPS_TABLE = `
CREATE TABLE IF NOT EXISTS purge_ops (
  op_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  store TEXT NOT NULL,
  ids TEXT NOT NULL,
  state TEXT NOT NULL,
  proof TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
) STRICT;
`;

export function applyPurgeV5(db: Database): void {
  db.exec(PURGE_OPS_TABLE);
}

export function initPurgeOps(db: Database): void {
  if (tableExists(db, "purge_ops")) return;
  applyPurgeV5(db);
}
