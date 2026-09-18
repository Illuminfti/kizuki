import type { Database } from "bun:sqlite";
import { classifySqliteFailure, LedgerStoreError } from "./errors";
import {
  LEDGER_BUSY_ATTEMPTS,
  LEDGER_BUSY_BACKOFF_MS,
  LEDGER_CONTROL_BUSY_TIMEOUT_MS,
} from "./limits";

/**
 * SQLite reports a contended write as SQLITE_BUSY or SQLITE_LOCKED, and Bun
 * renders both as `database is locked`. Every seam that turns contention into
 * a retry or a typed refusal asks here, so no caller matches that text twice.
 *
 * Only the failure SQLite itself raised counts. An error that already carries
 * its own closed contract, such as the ledger identity diagnostic that renders
 * `sqlite_code=SQLITE_BUSY` into its message, keeps that contract; reading
 * contention out of rendered text would replace a deliberate refusal with this
 * one.
 */
export function isLedgerBusy(error: unknown): boolean {
  if (error instanceof LedgerStoreError) return error.code === "busy";
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string") {
    return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
  }
  return error.name === "SQLiteError" && classifySqliteFailure(error)?.code === "busy";
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
  const run = (): T => db.transaction(work).immediate();
  let nested: boolean;
  try {
    nested = db.inTransaction;
  } catch {
    // A closed or otherwise unusable handle reports itself through the
    // transaction it refuses, which is the failure callers already classify.
    return run();
  }
  if (nested) return run();
  return retryWhileBusy(run, attempts);
}

/**
 * Run one control-store publication, which fails closed instead of queueing.
 * Consent and connection-state writes must land with the file or row they name
 * or not at all, so a live holder means another writer owns that publication
 * and this caller has to hear it now, not after the ordinary batch wait. The
 * connection's usual wait is restored either way.
 */
export function withControlWait<T>(db: Database, work: () => T): T {
  let previous: number | undefined;
  try {
    previous = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout;
    db.exec(`PRAGMA busy_timeout=${LEDGER_CONTROL_BUSY_TIMEOUT_MS}`);
  } catch {
    // A handle that cannot report its wait cannot be narrowed or restored.
    return work();
  }
  try {
    return work();
  } finally {
    if (previous !== undefined) {
      try { db.exec(`PRAGMA busy_timeout=${previous}`); } catch { /* closed handle */ }
    }
  }
}
