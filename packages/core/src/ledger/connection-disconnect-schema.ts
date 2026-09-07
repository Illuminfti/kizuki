import type { Database } from "bun:sqlite";
import { LedgerStoreError } from "./errors";
import { oneShotGet } from "./schema";

export const DISCONNECT_RECEIPT_COLUMNS = ["sequence", "receipt_id", "operation_id", "connector_id", "source_key", "connected_at", "enrollment_digest", "disconnected_at", "phase", "at", "diagnostic"] as const;
export const DISCONNECT_RECEIPT_STREAM = "ledger/connection_disconnect_receipts.jsonl";

const SCHEMA = {
  connection_disconnect_receipts: `CREATE TABLE connection_disconnect_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL UNIQUE CHECK(length(receipt_id)=26),
    operation_id TEXT NOT NULL CHECK(length(operation_id)=26),
    connector_id TEXT NOT NULL CHECK(length(connector_id) BETWEEN 1 AND 256),
    source_key TEXT NOT NULL REFERENCES connections(source_key),
    connected_at TEXT NOT NULL,
    enrollment_digest TEXT NOT NULL CHECK(length(enrollment_digest)=64 AND enrollment_digest NOT GLOB '*[^0-9a-f]*'),
    disconnected_at TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('started','revoked','revoke_failed')),
    at TEXT NOT NULL,
    diagnostic TEXT CHECK((phase='revoke_failed' AND diagnostic IS 'provider_revoke_failed') OR (phase<>'revoke_failed' AND diagnostic IS NULL))
  ) STRICT`,
  connection_disconnect_operation: "CREATE INDEX connection_disconnect_operation ON connection_disconnect_receipts(operation_id,sequence)",
  connection_disconnect_no_update: "CREATE TRIGGER connection_disconnect_no_update BEFORE UPDATE ON connection_disconnect_receipts BEGIN SELECT RAISE(ABORT,'disconnect receipts are append-only'); END",
  connection_disconnect_no_delete: "CREATE TRIGGER connection_disconnect_no_delete BEFORE DELETE ON connection_disconnect_receipts BEGIN SELECT RAISE(ABORT,'disconnect receipts are append-only'); END",
};

export function applyConnectionDisconnectV22(db: Database): void {
  for (const sql of Object.values(SCHEMA)) db.exec(sql);
}

export function assertConnectionDisconnectSchema(db: Database): void {
  const normalized = (sql: string) => sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
  for (const [name, sql] of Object.entries(SCHEMA)) {
    const row = oneShotGet<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE name=?", name);
    if (row === null || normalized(row.sql) !== normalized(sql)) throw new LedgerStoreError("corrupt", "connection disconnect schema is invalid");
  }
}
