import type { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { tableExists } from "../ledger/schema";
import { RECEIPTS_PATH } from "./receipt-path";
import { rowToReceiptRecord, type CanonReceiptRow } from "./receipts";

const PAGE = 256;

/**
 * Recreate the receipt journal file from the ledger's receipt rows inside a
 * private, unpublished vault. Restore inserts receipts as rows only, so without
 * this the restored vault holds rows that no journal line vouches for.
 * The journal is derived from the rows in the writer's order: `at`, then id.
 */
export function rebuildReceiptJournal(db: Database, vaultPath: string): number {
  const path = join(vaultPath, RECEIPTS_PATH);
  if (existsSync(path)) {
    if (statSync(path).size > 0) throw new Error("receipt journal already holds receipts");
    unlinkSync(path);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  let count = 0;
  try {
    if (tableExists(db, "canon_receipts")) {
      let cursor: { at: string; receipt_id: string } | null = null;
      for (;;) {
        const rows: CanonReceiptRow[] = cursor === null
          ? db.query<CanonReceiptRow, [number]>("SELECT * FROM canon_receipts ORDER BY COALESCE(at,erased_at), receipt_id LIMIT ?").all(PAGE)
          : db.query<CanonReceiptRow, [string, string, string, number]>(
            `SELECT * FROM canon_receipts WHERE COALESCE(at,erased_at) > ? OR (COALESCE(at,erased_at) = ? AND receipt_id > ?)
             ORDER BY COALESCE(at,erased_at), receipt_id LIMIT ?`).all(cursor.at, cursor.at, cursor.receipt_id, PAGE);
        if (rows.length === 0) break;
        writeSync(fd, rows.map(row => `${JSON.stringify(rowToReceiptRecord(row))}\n`).join(""));
        count += rows.length;
        const last = rows[rows.length - 1]!;
        if (rows.length < PAGE) break;
        cursor = { at: last.at ?? last.erased_at!, receipt_id: last.receipt_id };
      }
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return count;
}
