import type { Database } from "bun:sqlite";
import { classifySqliteFailure, LedgerStoreError } from "./errors";
import { LEDGER_BUSY_ATTEMPTS, LEDGER_BUSY_BACKOFF_MS } from "./limits";

/**
 * SQLite reports a contended write as SQLITE_BUSY or SQLITE_LOCKED, and Bun
 * renders both as `database is locked`. Every seam that turns contention into
 * a retry or a typed refusal asks here, so no caller matches that text twice.
 */
export function isLedgerBusy(error: unknown): boolean {
  if (error instanceof LedgerStoreError) return error.code === "busy";
  return classifySqliteFailure(error)?.code === "busy";
}

/**
 * Repeat idempotent ledger work while the ledger is busy, within a bound.
 * The connection's busy timeout already waits inside one attempt; these
 * retries survive a writer that holds the lock across several such waits and
 * still let the caller stop with an actionable refusal rather than hang.
 */
export function retryWhileBusy<T>(
  work: () => T,
  attempts: number = LEDGER_BUSY_ATTEMPTS,
): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return work();
    } catch (error) {
      if (attempt >= attempts || !isLedgerBusy(error)) throw error;
      Bun.sleepSync(LEDGER_BUSY_BACKOFF_MS * attempt);
    }
  }
}

/**
 * Run one top-level write transaction, retrying while the ledger is busy.
 *
 * `BEGIN IMMEDIATE` takes the write lock before any statement runs, so a
 * refused attempt applied nothing and retrying it is not a partial replay.
 * A nested call is a savepoint inside somebody else's transaction: retrying
 * there would redo work the outer transaction already holds, so the caller
 * that owns the top-level transaction owns the retry too.
 */
export function runImmediate<T>(
  db: Database,
  work: () => T,
  attempts: number = LEDGER_BUSY_ATTEMPTS,
): T {
  if (db.inTransaction) return db.transaction(work).immediate();
  return retryWhileBusy(() => db.transaction(work).immediate(), attempts);
}
