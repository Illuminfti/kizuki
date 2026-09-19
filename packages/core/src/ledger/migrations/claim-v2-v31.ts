import type { Database } from "bun:sqlite";
import { applyClaimV2Tables } from "../../claims/claim-v2-schema";

/**
 * Ledger migration 31 (RFC 0003 B1b). Installs the claim/v2 semantic and
 * support tables and their indexes. Additive only: it creates tables and
 * indexes that did not exist and touches no existing row, so a re-run is a
 * no-op and an interrupted run rolls back with the enclosing transaction.
 */
export function applyClaimV2TablesV31(db: Database): void {
  applyClaimV2Tables(db);
}
