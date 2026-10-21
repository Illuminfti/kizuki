import type { Database } from "bun:sqlite";

/**
 * Ledger migration for connector cursor storage. The host-held side map of a connector that declares
 * `cursor_store: "host"`. Additive: one new table, no existing row touched.
 * The connection foreign key matches `checkpoints`, so a map cannot outlive
 * or precede the connection its checkpoint belongs to.
 */
export function applyCursorStoreV35(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_cursor_store (
      connector_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      bytes INTEGER NOT NULL CHECK (bytes > 0),
      PRIMARY KEY (connector_id, source_key, key),
      FOREIGN KEY (connector_id, source_key)
        REFERENCES connections(connector_id, source_key)
    ) STRICT, WITHOUT ROWID;
  `);
}
