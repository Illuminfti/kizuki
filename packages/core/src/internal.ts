/**
 * Composition-root opener. Not the public policy boundary: callers still go
 * through accept, purge, ingest, and the receipted writer for mutation.
 */
export { openLedger } from "./ledger/db";
export { openLedgerRead, LedgerReadError } from "./ledger/read-context";
export type { LedgerReadContext } from "./ledger/read-context";
export { inspectLedgerIdentity, LedgerIdentityError } from "./ledger/identity";
export { parseSqliteRuntime, readSqliteRuntime } from "./ledger/runtime";
export type { SqliteRuntime } from "./ledger/runtime";
export { assertBoundVaultId } from "./serve/vault-id";
