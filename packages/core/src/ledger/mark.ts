import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { readOwnedLine, writeOwnedFile } from "../serve/vault-id";

/**
 * Sibling of vault-id. One line: the accepted total the ledger held when a
 * Kizuki process last closed it. Written outside SQLite on purpose: committed
 * rows can still sit in the WAL when the daemon holds the file open, and a
 * stop/resume that carries `kizuki.db` without `kizuki.db-wal` reads an honest
 * zero from a vault whose identity is intact. The mark is the reader's only
 * way to tell that store from a genuinely empty one.
 */
export const LEDGER_MARK_PATH = ".kizuki/ledger-mark";

function ledgerMarkPath(vaultPath: string): string {
  return join(vaultPath, LEDGER_MARK_PATH);
}

/**
 * Events ever accepted: live rows plus purge receipts. Purge deletes the row
 * and writes the receipt in one transaction, so this never decreases and a
 * reader can compare against it with `<` alone.
 */
export function ledgerAccepted(db: Database): number {
  const row = db
    .query<{ accepted: number }, []>(
      "SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM event_purges) AS accepted",
    )
    .get();
  return row?.accepted ?? 0;
}

/** Null when absent or not a non-negative integer; the caller treats both as "unsealed". */
export function readLedgerMark(vaultPath: string): number | null {
  const line = readOwnedLine(ledgerMarkPath(vaultPath));
  if (line === null || !/^(0|[1-9][0-9]{0,15})$/.test(line)) return null;
  return Number(line);
}

export function writeLedgerMark(vaultPath: string, accepted: number): void {
  if (!Number.isSafeInteger(accepted) || accepted < 0) {
    throw new TypeError("ledger mark must be a non-negative integer");
  }
  writeOwnedFile(ledgerMarkPath(vaultPath), `${accepted}\n`, false);
}

/** Record what this process could read. A lower stale mark is harmless; a higher one is never written. */
export function sealLedger(vaultPath: string, db: Database): number {
  const accepted = ledgerAccepted(db);
  writeLedgerMark(vaultPath, accepted);
  return accepted;
}
