import { openLedger } from "../../src/ledger/db";
import { acquireLease, thisProcess } from "../../src/serve/leases";

const path = process.argv[2];
if (path === undefined) throw new Error("synthetic ledger path is required");
const db = openLedger(path);
try {
  const result = acquireLease(db, thisProcess());
  process.stdout.write(
    `${JSON.stringify({
      acquired: result.acquired,
      reason: result.reason,
      pid: process.pid,
      holder: result.lease?.holder_pid ?? null,
    })}\n`,
  );
} finally {
  db.close();
}
