import { openLedger } from "../src/ledger/db";

/**
 * Hold the SQLite write lock for a fixed span, the way a serve rail batch
 * does. Prints `held` once the lock is taken so the parent can start the work
 * that has to survive it.
 */
const path = process.argv[2];
const holdMs = Number(process.argv[3] ?? "0");
if (path === undefined || !Number.isSafeInteger(holdMs) || holdMs < 0) {
  throw new Error("synthetic ledger path and hold duration are required");
}
const db = openLedger(path);
try {
  db.exec("BEGIN IMMEDIATE");
  db.exec("CREATE TABLE IF NOT EXISTS busy_probe (value INTEGER)");
  process.stdout.write("held\n");
  Bun.sleepSync(holdMs);
  db.exec("ROLLBACK");
  process.stdout.write("released\n");
} finally {
  db.close();
}
