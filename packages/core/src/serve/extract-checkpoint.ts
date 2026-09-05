import type { Database } from "bun:sqlite";
import { assertCursorSize, writeResumeCursor } from "../ledger/connections";
import { MODEL_PRODUCER_ID } from "../producer";

export type ExtractCheckpointKey = "extract" | "extract-deferred-scan";

/** Advance an extraction-owned cursor inside the transaction that justifies it. */
export function advanceExtractCheckpoint(
  db: Database,
  sourceKey: ExtractCheckpointKey,
  cursor: string,
): void {
  if (!db.inTransaction) throw new Error("extraction checkpoint advancement requires a transaction");
  if (sourceKey !== "extract" && sourceKey !== "extract-deferred-scan") throw new Error("invalid extraction checkpoint key");
  const bounded = assertCursorSize(cursor, "extraction checkpoint cursor");
  if (bounded === null || bounded.length === 0) throw new Error("extraction checkpoint cursor must be non-empty");
  writeResumeCursor(db, MODEL_PRODUCER_ID, sourceKey, bounded);
}
