import type { Database } from "bun:sqlite";
import { isRfc3339 } from "../util/time";
import { LedgerError } from "./connections";

/** The one column a staged swap and a fresh timestamp both read. */
export interface ConnectedAtRow {
  connected_at: string;
}

/** The row a staged swap must still find when it commits. */
export interface ConnectionExpectation {
  connected_at: string;
  disconnected_at: string | null;
}

/** Another writer committed while these bytes were being staged. */
export const CONCURRENT_CONNECTION_CHANGE =
  "connection changed while its state was being replaced";
/** A writer in another process holds the lock this one has to swap under. */
const LOCKED_CONTROL_STORE = "connection state is locked by another writer";

function isLockedDatabase(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = error.code;
  return (
    typeof code === "string" &&
    (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  );
}

/**
 * The durable swap and the row that names it have to land together. A writer
 * in another process that renamed its own file between this one's rename and
 * its commit would leave the row naming bytes this one's rollback then took
 * away, and a recovery running at the same moment would read a live swap as
 * crash debris. The database's write lock is the only lock both processes
 * already share, so every file move happens while it is held.
 *
 * `rollback` undoes the file moves `work` made and runs under that same lock:
 * released first, it would race a recovery in another process that had already
 * repaired this journal, and the restore would then delete the bytes that
 * recovery had just put back.
 */
export function writeLocked(
  db: Database,
  work: () => void,
  rollback?: () => void,
): void {
  try {
    db.transaction(() => {
      if (rollback === undefined) {
        work();
        return;
      }
      try {
        work();
      } catch (error) {
        try {
          rollback();
        } catch {
          // The journal the rollback could not remove is the record recovery
          // reads, so the next recover() finishes the undo. What the caller
          // has to act on is the failure that started this.
        }
        throw error;
      }
    }).immediate();
  } catch (error) {
    if (isLockedDatabase(error)) {
      throw new LedgerError(LOCKED_CONTROL_STORE, { cause: error });
    }
    throw error;
  }
}

/** Monotonic per source: a rewrite in the same millisecond still advances. */
export function nextConnectedAt(
  db: Database,
  connectorId: string,
  sourceKey: string,
): string {
  const previous = db
    .query<ConnectedAtRow, [string, string]>(
      "SELECT connected_at FROM connections WHERE connector_id = ? AND source_key = ?",
    )
    .get(connectorId, sourceKey);
  const previousMillis =
    previous === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.connected_at);
  if (previous !== null && !Number.isFinite(previousMillis)) {
    throw new LedgerError("stored connection timestamp is invalid");
  }
  const millis = Math.max(Date.now(), previousMillis + 1);
  const connectedAt = new Date(millis).toISOString();
  if (!isRfc3339(connectedAt)) {
    throw new LedgerError("core generated an invalid connection timestamp");
  }
  return connectedAt;
}

export interface ConnectionRowWrite {
  connectorId: string;
  sourceKey: string;
  config: string;
  secretRefs: string[];
  connectedAt: string;
  /** The row the caller validated; absent for a first enrollment. */
  expect: ConnectionExpectation | undefined;
}

/**
 * Writes the row that names the state file just swapped into place. With an
 * expectation it is a compare-and-set, which is what keeps a disconnect or a
 * competing rewrite that landed during the staging window from being undone.
 */
export function commitConnectionRow(
  db: Database,
  write: ConnectionRowWrite,
): void {
  const refs = JSON.stringify(write.secretRefs);
  if (write.expect === undefined) {
    db.query(
      `INSERT INTO connections
         (connector_id, source_key, config, secret_refs, connected_at, disconnected_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT (connector_id, source_key) DO UPDATE SET
         config = excluded.config, secret_refs = excluded.secret_refs,
         connected_at = excluded.connected_at, disconnected_at = NULL`,
    ).run(
      write.connectorId,
      write.sourceKey,
      write.config,
      refs,
      write.connectedAt,
    );
    return;
  }
  const result = db
    .query(
      `UPDATE connections
          SET config = ?, secret_refs = ?, connected_at = ?, disconnected_at = NULL
        WHERE connector_id = ? AND source_key = ?
          AND connected_at = ? AND disconnected_at IS ?`,
    )
    .run(
      write.config,
      refs,
      write.connectedAt,
      write.connectorId,
      write.sourceKey,
      write.expect.connected_at,
      write.expect.disconnected_at,
    );
  if (result.changes !== 1) {
    throw new LedgerError(CONCURRENT_CONNECTION_CHANGE);
  }
}
