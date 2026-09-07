import { Database, constants } from "bun:sqlite";
import { join, resolve } from "node:path";
import { openLedgerDirectory } from "../vault/canon-files";
import { bindServingAudit } from "../serving/audit-capability";
import { LEDGER_SCHEMA_VERSION } from "./db";
import { assertLedgerSchema } from "./integrity";
import { LEDGER_BUSY_TIMEOUT_MS } from "./limits";
import { manageDatabaseLifetime } from "./lifetime";
import { configureLedgerWalLifecycle } from "./wal-lifecycle";

export class LedgerReadError extends Error {
  constructor(readonly code: "migration_required" | "custody_unavailable") { super(code); }
}

export interface LedgerReadContext {
  readonly db: Database;
  assertCurrent(): void;
  close(): void;
}

/**
 * Existing-file, noninitializing SQL read binding for trusted Core consumers.
 * SQLite may create/update WAL/SHM metadata; query_only prohibits data/schema
 * mutation. This is not a hostile-JavaScript sandbox or a zero-filesystem-write claim.
 * Required access audit writes use a separate private handle to this same inode.
 */
export function openLedgerRead(vaultPath: string, options: { audit?: boolean } = {}): LedgerReadContext {
  const path = join(resolve(vaultPath), ".kizuki", "kizuki.db");
  let directory: ReturnType<typeof openLedgerDirectory>;
  try { directory = openLedgerDirectory(resolve(vaultPath)); }
  catch { throw new LedgerReadError("custody_unavailable"); }
  let db: Database | undefined, writer: Database | undefined, closed = false;
  let original: ReturnType<typeof directory.inspectFileIdentity>;
  try { original = directory.inspectFileIdentity("kizuki.db"); }
  catch { directory.close(); throw new LedgerReadError("custody_unavailable"); }
  const assertCurrent = (): void => {
    if (closed || original === null) throw new LedgerReadError("custody_unavailable");
    try {
      const current = directory.inspectFileIdentity("kizuki.db");
      for (const name of ["kizuki.db-wal", "kizuki.db-shm"] as const) directory.inspectFileIdentity(name);
      // Opening a hot rollback journal could recover database bytes before a
      // read. Only ordinary WAL/SHM mechanics belong to this capability.
      if (directory.inspectFileIdentity("kizuki.db-journal") !== null) throw new LedgerReadError("custody_unavailable");
      if (current === null || current.dev !== original.dev || current.ino !== original.ino) {
        throw new LedgerReadError("custody_unavailable");
      }
    } catch { throw new LedgerReadError("custody_unavailable"); }
  };
  const open = (read: boolean): Database => {
    assertCurrent();
    const handle = manageDatabaseLifetime(new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW));
    try {
      configureLedgerWalLifecycle(handle, path);
      if (read) handle.exec("PRAGMA query_only = ON");
      handle.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
      handle.exec("PRAGMA foreign_keys = ON");
      assertCurrent();
      try {
        assertLedgerSchema(handle, LEDGER_SCHEMA_VERSION);
        // These authoritative surfaces used to be silently repaired by initAgents,
        // initServe and initCanon. Reads require them, without creating any object.
        for (const query of [
          "SELECT agent_id, quarantined_at, quarantine_reason FROM agents LIMIT 0",
          "SELECT relay_owner_corrections, grant_epoch FROM agent_grants LIMIT 0",
          "SELECT audit_id, served_count, denied_count, grant_epoch FROM agent_audit LIMIT 0",
          "SELECT * FROM canon_receipts LIMIT 0", "SELECT * FROM page_index LIMIT 0",
          "SELECT * FROM canon_source_erasure_intents LIMIT 0", "SELECT * FROM claims LIMIT 0",
          "SELECT * FROM schedules LIMIT 0", "SELECT * FROM run_receipts LIMIT 0",
          "SELECT input_ids, integrity, outcome, batch_mode, model_inputs, deferred_inputs FROM extract_batches LIMIT 0",
        ]) handle.query(query).all();
      }
      catch {
        // A schema error can follow an inode swap; custody takes precedence.
        assertCurrent();
        throw new LedgerReadError("migration_required");
      }
      assertCurrent();
      return handle;
    } catch (error) { handle.close(); throw error; }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { writer?.close(); } finally { try { db?.close(); } finally { directory.close(); } }
  };
  try {
    db = open(true);
    if (options.audit) {
      writer = open(false);
      bindServingAudit(db, writer, assertCurrent);
    }
    return Object.freeze({ db, assertCurrent, close });
  } catch (error) { close(); throw error; }
}
