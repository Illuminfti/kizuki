import { constants, type Database } from "bun:sqlite";
import { LedgerStoreError } from "./errors";

/** Apple SQLite defaults to persistent journals. Every participating writable
 * or query-only handle must agree on SQLite-owned last-connection cleanup. */
export function configureLedgerWalLifecycle(db: Database, path: string): void {
  if (process.platform !== "darwin" || path === ":memory:" || path === "") return;
  let status: number;
  try { status = db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0); }
  catch { throw new LedgerStoreError("infrastructure", "ledger WAL lifecycle is unavailable"); }
  if (status !== 0) throw new LedgerStoreError("infrastructure", "ledger WAL lifecycle is unavailable");
}
