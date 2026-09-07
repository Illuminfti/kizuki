import { Database, constants } from "bun:sqlite";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openCredentialDirectory, type CredentialDirectory } from "../agents/credential-file";

export class LedgerIdentityError extends Error {
  constructor(readonly code: "invalid_ledger" | "busy" | "custody_unavailable") {
    super(code === "busy" ? "vault ledger changed during identity check; retry" : "vault ledger identity is unavailable");
  }
}

const sidecars = ["kizuki.db-wal", "kizuki.db-shm", "kizuki.db-journal"] as const;

function readIdentity(db: Database): { schemaVersion: number } {
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_version', 'events')",
  ).all();
  if (tables.length !== 2) throw new LedgerIdentityError("invalid_ledger");
  const versions = db.query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 2").all();
  if (versions.length !== 1 || !Number.isSafeInteger(versions[0]?.version) || (versions[0]?.version ?? 0) < 1) {
    throw new LedgerIdentityError("invalid_ledger");
  }
  return { schemaVersion: versions[0]!.version };
}

function readAndClose(db: Database): { schemaVersion: number } {
  try { return db.transaction(() => readIdentity(db)).deferred(); }
  finally {
    try { db.close(true); }
    catch { throw new LedgerIdentityError("custody_unavailable"); }
  }
}

/** Identity only: callers never receive an immutable database or arbitrary query seam. */
export function inspectLedgerIdentity(vaultPath: string): { schemaVersion: number } {
  const path = join(resolve(vaultPath), ".kizuki", "kizuki.db");
  if (process.platform !== "darwin") {
    try { return readAndClose(new Database(path, { readonly: true })); }
    catch { throw new LedgerIdentityError("invalid_ledger"); }
  }

  let directory: CredentialDirectory;
  try { directory = openCredentialDirectory(join(resolve(vaultPath), ".kizuki")); }
  catch { throw new LedgerIdentityError("custody_unavailable"); }
  try {
    const original = directory.inspectFileIdentity("kizuki.db");
    if (original === null) throw new LedgerIdentityError("custody_unavailable");
    const parent = JSON.stringify(directory.observe());
    const observedSidecars = sidecars.map(name => directory.inspectFileIdentity(name));
    if (observedSidecars.some(value => value !== null)) {
      // Live SQLite must see committed WAL frames. Never substitute a main-only
      // immutable view when a journal is present, even if that journal is empty.
      const result = readAndClose(new Database(path, { readonly: true }));
      try {
        const current = directory.inspectFileIdentity("kizuki.db");
        if (current === null || current.dev !== original.dev || current.ino !== original.ino ||
            JSON.stringify(directory.observe()) !== parent) throw new LedgerIdentityError("busy");
      } catch { throw new LedgerIdentityError("busy"); }
      return result;
    }

    const snapshot = () => {
      try {
        const database = directory.inspectFileIdentity("kizuki.db");
        if (database === null || database.dev !== original.dev || database.ino !== original.ino) throw new LedgerIdentityError("busy");
        const observation = JSON.stringify({ parent: directory.observe(), database });
        for (const name of sidecars) if (directory.inspectFileIdentity(name) !== null) throw new LedgerIdentityError("busy");
        return observation;
      } catch { throw new LedgerIdentityError("busy"); }
    };
    const before = snapshot();
    let result: { schemaVersion: number } | undefined;
    let failure: unknown;
    try {
      result = readAndClose(new Database(`${pathToFileURL(path).href}?immutable=1&mode=ro`,
        constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW));
    } catch (error) { failure = error; }
    // Check even when SQLite refused: a raced writer is busy, not evidence that
    // a previously admitted ledger is foreign or safe to repair.
    if (snapshot() !== before) throw new LedgerIdentityError("busy");
    if (failure !== undefined) throw failure;
    if (result === undefined) throw new LedgerIdentityError("invalid_ledger");
    return result;
  } catch (error) {
    if (error instanceof LedgerIdentityError) throw error;
    if (error instanceof Error && error.message.startsWith("credential_file_")) throw new LedgerIdentityError("custody_unavailable");
    throw new LedgerIdentityError("invalid_ledger");
  } finally { directory.close(); }
}
