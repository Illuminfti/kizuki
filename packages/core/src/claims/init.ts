import type { Database } from "bun:sqlite";
import { ensureLedgerInitialized, LEDGER_SCHEMA_VERSION } from "../ledger/db";
import { LedgerStoreError } from "../ledger/errors";
import { readSchemaVersion } from "../ledger/integrity";
import { claimsCompatibilityReady } from "./schema";

function ledgerVersionCurrent(db: Database): boolean {
  try {
    return readSchemaVersion(db) === LEDGER_SCHEMA_VERSION;
  } catch (error) {
    if (error instanceof LedgerStoreError && error.code === "corrupt") return false;
    throw error;
  }
}

/** Cheap no-op on a healthy current ledger. Otherwise request the migrator. */
export function initClaims(db: Database): void {
  if (claimsCompatibilityReady(db) && ledgerVersionCurrent(db)) return;
  ensureLedgerInitialized(db, { includeStaging: true });
}
