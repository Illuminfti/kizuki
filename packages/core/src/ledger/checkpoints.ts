import type { Database } from "bun:sqlite";
import type { Cursor } from "../contracts/connector";

/**
 * Persisted resume tokens, one per (connector, source). The cursor is opaque:
 * the spine stores what the connector minted and hands it back verbatim, so
 * `sync` can resume — and emit tombstones — instead of re-walking history.
 */

export function readCheckpoint(
  db: Database,
  connectorId: string,
  sourceKey: string,
): Cursor | null {
  const row = db
    .query<{ cursor: string }, [string, string]>(
      "SELECT cursor FROM checkpoints WHERE connector_id = ? AND source_key = ?",
    )
    .get(connectorId, sourceKey);
  return row === null ? null : row.cursor;
}

export function writeCheckpoint(
  db: Database,
  connectorId: string,
  sourceKey: string,
  cursor: Cursor,
): void {
  db.query<never, [string, string, string, string]>(
    `INSERT INTO checkpoints (connector_id, source_key, cursor, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (connector_id, source_key)
       DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  ).run(connectorId, sourceKey, cursor, new Date().toISOString());
}
