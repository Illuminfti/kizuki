import { Database, constants } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LEDGER_SCHEMA_VERSION } from "../ledger/db";
import { assertLedgerSchema, inspectLedgerHealth } from "../ledger/integrity";
import { openLedgerDirectory } from "../vault/canon-files";
import { assertWorldState } from "./integrity";
import { assertClaimHistory } from "./tables/known";

export const WORLD_INTEGRITY_CHECKS = ["ledger_schema", "ledger_integrity", "world_provenance", "world_history"] as const;
export interface WorldIntegrityReport {
  readonly schema: "kizuki.world-verification/v1";
  readonly ok: boolean;
  readonly checks: readonly { readonly id: typeof WORLD_INTEGRITY_CHECKS[number]; readonly status: "PASS" | "FAIL" }[];
  readonly error?: "custody_unavailable" | "copy_not_quiescent" | "copy_changed";
}

/** Stored-state audit only: no model calls, extraction or repair. These checks
 * do not stand in for the synthetic authorization and interface test harness. */
export function inspectWorldIntegrity(db: Database): WorldIntegrityReport {
  const checks = WORLD_INTEGRITY_CHECKS.map((id) => {
    let passed = false;
    try {
      switch (id) {
        case "ledger_schema": assertLedgerSchema(db, LEDGER_SCHEMA_VERSION); passed = true; break;
        case "ledger_integrity": passed = inspectLedgerHealth(db, { full: true, expectedVersion: LEDGER_SCHEMA_VERSION }).ok; break;
        case "world_provenance": assertWorldState(db); passed = true; break;
        case "world_history": assertClaimHistory(db); passed = true; break;
      }
    } catch { /* Reports contain stable check names, never private rows or SQL errors. */ }
    return { id, status: passed ? "PASS" as const : "FAIL" as const };
  });
  return { schema: "kizuki.world-verification/v1", ok: checks.every((check) => check.status === "PASS"), checks };
}

/** Audit an offline, checkpointed copy. Immutable SQLite skips WAL recovery and
 * never creates sidecars. Refuse sidecars rather than silently omitting their
 * data. This intentionally does not use the ordinary query-only serving reader,
 * whose supported WAL mechanics can write filesystem metadata. */
export function verifyWorldCopy(vaultPath: string): WorldIntegrityReport {
  const fail = (error: NonNullable<WorldIntegrityReport["error"]>): WorldIntegrityReport => ({
    schema: "kizuki.world-verification/v1", ok: false, checks: WORLD_INTEGRITY_CHECKS.map((id) => ({ id, status: "FAIL" })), error,
  });
  const vault = resolve(vaultPath), path = join(vault, ".kizuki", "kizuki.db");
  let directory: ReturnType<typeof openLedgerDirectory> | undefined, db: Database | undefined;
  try {
    directory = openLedgerDirectory(vault);
    const original = directory.inspectFileIdentity("kizuki.db");
    if (original === null) return fail("custody_unavailable");
    const stableFile = () => {
      const identity = directory!.inspectFileIdentity("kizuki.db");
      const stat = lstatSync(path, { bigint: true });
      if (identity?.dev !== original.dev || identity.ino !== original.ino ||
          stat.dev.toString() !== original.dev || stat.ino.toString() !== original.ino) throw new Error("changed");
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(":");
    };
    const quiescent = () => (["kizuki.db-wal", "kizuki.db-shm", "kizuki.db-journal"] as const)
      .every((name) => directory!.inspectFileIdentity(name) === null);
    if (!quiescent()) return fail("copy_not_quiescent");
    const before = stableFile();
    const uri = pathToFileURL(path); uri.searchParams.set("immutable", "1");
    db = new Database(uri.href, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW);
    if (!quiescent() || stableFile() !== before) return fail("copy_changed");
    const report = inspectWorldIntegrity(db);
    db.close(); db = undefined;
    if (!quiescent() || stableFile() !== before) return fail("copy_changed");
    return report;
  } catch { return fail("custody_unavailable"); }
  finally { try { db?.close(); } finally { directory?.close(); } }
}
