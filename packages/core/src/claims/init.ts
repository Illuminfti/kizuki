import type { Database } from "bun:sqlite";
import { ensureLedgerInitialized, LEDGER_SCHEMA_VERSION } from "../ledger/db";
import { assertLedgerSchema } from "../ledger/integrity";
import { claimsCompatibilityReady } from "./schema";

function currentLedgerReady(db: Database): boolean {
  try {
    assertLedgerSchema(db, LEDGER_SCHEMA_VERSION);
    return true;
  } catch {
    return false;
  }
}

/** Cheap no-op on a healthy current ledger. Otherwise request the migrator. */
export function initClaims(db: Database): void {
  if (claimsCompatibilityReady(db) && currentLedgerReady(db)) return;
  ensureLedgerInitialized(db, { includeStaging: true });
}