import type { Database } from "bun:sqlite";
import type { Cursor } from "../contracts/connector";
import { getCheckpoint } from "./connections";

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
