import type { Database } from "bun:sqlite";
import {
  MAX_CURSOR_STORE_BYTES,
  MAX_CURSOR_STORE_ENTRIES,
  MAX_CURSOR_STORE_KEY_BYTES,
  type CursorStoreDelta,
} from "../contracts/connector";
import { LedgerError } from "./connections";

const encoder = new TextEncoder();

function entryBytes(key: string, value: string): number {
  return encoder.encode(key).byteLength + encoder.encode(value).byteLength;
}

/**
 * Why a connector-supplied delta cannot be read as a side-map change, or null.
 * Content-free: the message names the bound, never the key or the value.
 */
export function cursorStoreDeltaError(delta: unknown): string | null {
  if (typeof delta !== "object" || delta === null || Array.isArray(delta)) {
    return "cursor_store must be an object";
  }
  for (const key of Object.keys(delta)) {
    const value = (delta as Record<string, unknown>)[key];
    if (key.length === 0 || encoder.encode(key).byteLength > MAX_CURSOR_STORE_KEY_BYTES) {
      return `cursor_store keys must be 1..${MAX_CURSOR_STORE_KEY_BYTES} bytes`;
    }
    if (value !== null && typeof value !== "string") {
      return "cursor_store values must be strings or null";
    }
  }
  return null;
}

/** The committed side map of one connection; empty when it never wrote one. */
export function readCursorStore(
  db: Database,
  connector_id: string,
  source_key: string,
): Map<string, string> {
  const map = new Map<string, string>();
  const rows = db
    .query<{ key: string; value: string }, [string, string]>(
      `SELECT key, value FROM connector_cursor_store
        WHERE connector_id = ? AND source_key = ?`,
    )
    .all(connector_id, source_key);
  for (const row of rows) map.set(row.key, row.value);
  return map;
}

/** Why `delta` applied to `current` would break the map bounds, or null. */
export function cursorStoreOverflow(
  current: ReadonlyMap<string, string>,
  delta: CursorStoreDelta,
): string | null {
  const merged = new Map(current);
  for (const [key, value] of Object.entries(delta)) {
    if (value === null) merged.delete(key);
    else merged.set(key, value);
  }
  let bytes = 0;
  for (const [key, value] of merged) bytes += entryBytes(key, value);
  if (merged.size > MAX_CURSOR_STORE_ENTRIES) {
    return `cursor_store would hold more than ${MAX_CURSOR_STORE_ENTRIES} entries`;
  }
  if (bytes > MAX_CURSOR_STORE_BYTES) {
    return `cursor_store would exceed ${MAX_CURSOR_STORE_BYTES} bytes`;
  }
  return null;
}

/**
 * Applies a delta. The caller owns the transaction: this runs inside the one
 * that writes the checkpoint, so map and checkpoint commit or roll back
 * together, and the bounds are re-checked against what the transaction
 * actually holds rather than trusted from an earlier read.
 */
export function applyCursorStore(
  db: Database,
  connector_id: string,
  source_key: string,
  delta: CursorStoreDelta,
): void {
  const entries = Object.entries(delta);
  if (entries.length === 0) return;
  const put = db.query(
    `INSERT INTO connector_cursor_store (connector_id, source_key, key, value, bytes)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (connector_id, source_key, key)
       DO UPDATE SET value = excluded.value, bytes = excluded.bytes`,
  );
  const drop = db.query(
    `DELETE FROM connector_cursor_store
      WHERE connector_id = ? AND source_key = ? AND key = ?`,
  );
  for (const [key, value] of entries) {
    if (value === null) drop.run(connector_id, source_key, key);
    else put.run(connector_id, source_key, key, value, entryBytes(key, value));
  }
  const total = db
    .query<{ bytes: number | null; entries: number }, [string, string]>(
      `SELECT SUM(bytes) AS bytes, COUNT(*) AS entries FROM connector_cursor_store
        WHERE connector_id = ? AND source_key = ?`,
    )
    .get(connector_id, source_key);
  if ((total?.bytes ?? 0) > MAX_CURSOR_STORE_BYTES || (total?.entries ?? 0) > MAX_CURSOR_STORE_ENTRIES) {
    throw new LedgerError("cursor_store exceeds its bound");
  }
}
