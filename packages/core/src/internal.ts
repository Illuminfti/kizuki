/**
 * Composition-root opener. Not the public policy boundary: callers still go
 * through accept, purge, ingest, and the receipted writer for mutation.
 */
export { openLedger } from "./ledger/db";
export { parseSqliteRuntime, readSqliteRuntime } from "./ledger/runtime";
export type { SqliteRuntime } from "./ledger/runtime";
