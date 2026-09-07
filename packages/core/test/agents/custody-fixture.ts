import { strict as assert } from "node:assert";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { hardenLedgerFile } from "../../src/vault/init";

// Inspect the environment independently; never skip because implementation fails.
export const credentialCustodyQualified = ((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64")) && (() => {
  const uid = process.geteuid?.();
  if (uid === undefined) return false;
  for (let path = tmpdir();; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) ||
      ((stat.mode & 0o022) !== 0 && (stat.uid !== 0 || (stat.mode & 0o1000) === 0))) return false;
    if (path === dirname(path)) return true;
  }
})();

/** Match private ledger setup before testing enrollment's fail-closed custody. */
export function initializeEnrollmentLedger(dbPath: string): void {
  const db = openLedger(dbPath);
  try { hardenLedgerFile(dbPath); } finally { db.close(); }
  const uid = process.geteuid?.();
  assert.notEqual(uid, undefined, "enrollment fixture requires a native owner");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const stat = lstatSync(dbPath + suffix, { throwIfNoEntry: false });
    if (stat === undefined && suffix !== "") continue;
    assert.ok(stat, "enrollment fixture ledger must exist");
    const metadata = { suffix, regular: stat.isFile(), links: stat.nlink, owner: stat.uid, mode: stat.mode & 0o7777 };
    assert.ok(metadata.regular && metadata.links === 1 && metadata.owner === uid && metadata.mode === 0o600,
      "enrollment fixture custody: " + JSON.stringify(metadata));
  }
}
