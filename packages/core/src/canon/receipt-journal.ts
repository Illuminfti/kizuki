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
      // One ordered scan streams the rows; paging with a keyset on the COALESCE expression would re-sort the table per page.
      let batch: string[] = [];
      for (const row of db.query<CanonReceiptRow, []>("SELECT * FROM canon_receipts ORDER BY COALESCE(at,erased_at), receipt_id").iterate()) {
        batch.push(`${JSON.stringify(rowToReceiptRecord(row))}\n`);
        count += 1;
        if (batch.length >= PAGE) { writeSync(fd, batch.join("")); batch = []; }
      }
      if (batch.length > 0) writeSync(fd, batch.join(""));
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return count;
}
