/**
 * Composition-root opener. Not the public policy boundary: callers still go
 * through accept, purge, ingest, and the receipted writer for mutation.
 */
export { LEDGER_SCHEMA_VERSION, openLedger } from "./ledger/db";
export { ledgerAccepted, readLedgerMark, sealLedger } from "./ledger/mark";
export {
  LEDGER_READY_DEADLINE_MS,
  ledgerNotReadyError,
  openLedgerRead,
  openReadyLedgerRead,
  LedgerReadError,
} from "./ledger/read-context";
export type { LedgerReadContext } from "./ledger/read-context";
export { inspectLedgerIdentity, LedgerIdentityError } from "./ledger/identity";
export { parseSqliteRuntime, readSqliteRuntime } from "./ledger/runtime";
export type { SqliteRuntime } from "./ledger/runtime";
export { assertBoundVaultId } from "./serve/vault-id";
export { SERVICE_BROKER_REAP_SECONDS, SERVICE_READY_SECONDS } from "./serve/units";
export { startServiceCustody, runServiceCustodyBroker, validateServiceCustodyLaunch, ServiceCustodyError } from "./serve/custody";
export type { ServiceCustodyHandle } from "./serve/custody";
export { indexEvent, indexPage, initSearch, removeCanonPath, removeDoc } from "./search";
export { eventRetrievalDoc, publishLedgerEvent } from "./retrieval/events";
export { initGraph } from "./graph";
export { rebuildDerived } from "./derived";
