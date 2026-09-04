import type { Database } from "bun:sqlite";
import type { Cursor } from "../contracts/connector";
import { getCheckpoint, writeResumeCursor } from "./connections";

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
  return getCheckpoint(db, connectorId, sourceKey)?.cursor ?? null;
}

/**
 * Extract-rail resume write. This is not a connector ingest receipt and does
 * not require a connections row; connector runs go through recordConnectorRun.
 */
export function writeCheckpoint(
  db: Database,
  connectorId: string,
  sourceKey: string,
  cursor: Cursor,
): void {
  writeResumeCursor(db, connectorId, sourceKey, cursor);
}
