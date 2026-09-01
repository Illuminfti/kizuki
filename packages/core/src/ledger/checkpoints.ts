import type { Database } from "bun:sqlite";
import type { Cursor } from "../contracts/connector";
import type { RunResult } from "../ingest/run";
import { getCheckpoint, saveCheckpoint } from "./connections";

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

export function writeCheckpoint(
  db: Database,
  connectorId: string,
  sourceKey: string,
  cursor: Cursor,
): void {
  const result: RunResult = {
    stored: 0,
    duplicates: 0,
    errors: [],
    proposals_created: 0,
    withdrawn: 0,
    retractions_filed: 0,
    cursor,
  };
  saveCheckpoint(db, connectorId, sourceKey, cursor, "sync", result);
}
