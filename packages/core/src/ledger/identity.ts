import { Database, constants } from "bun:sqlite";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openCredentialDirectory, type CredentialDirectory } from "../agents/credential-file";

type IdentityPhase = "open" | "tables" | "version" | "transaction" | "close";
type IdentityDiagnostic =
  | { readonly phase: "tables" | "version"; readonly kind: "semantic"; readonly reason: "missing_tables" | "invalid_version" }
  | { readonly phase: IdentityPhase; readonly kind: "sqlite"; readonly sqlite_code: string; readonly sqlite_errno: number }
  | { readonly phase: IdentityPhase; readonly kind: "unknown" };

function diagnosticText(diagnostic: IdentityDiagnostic): string {
  return ` [phase=${diagnostic.phase} kind=${diagnostic.kind}` +
    (diagnostic.kind === "semantic" ? ` reason=${diagnostic.reason}` : diagnostic.kind === "sqlite"
      ? ` sqlite_code=${diagnostic.sqlite_code} sqlite_errno=${diagnostic.sqlite_errno}` : "") + "]";
}

export class LedgerIdentityError extends Error {
  readonly diagnostic?: IdentityDiagnostic;
  constructor(readonly code: "invalid_ledger" | "busy" | "custody_unavailable", options?: ErrorOptions, diagnostic?: IdentityDiagnostic) {
    super((code === "busy" ? "vault ledger changed during identity check; retry" : "vault ledger identity is unavailable") +
      (diagnostic === undefined ? "" : diagnosticText(diagnostic)), options);
    if (diagnostic !== undefined) this.diagnostic = Object.freeze(diagnostic);
  }
}

// Only these primary SQLite result-code pairs may enter a public diagnostic.
// Unrecognized or extended codes remain unknown; messages, SQL and paths never enter it.
const sqliteCodes = new Map([
  ["SQLITE_ERROR", 1], ["SQLITE_BUSY", 5], ["SQLITE_LOCKED", 6], ["SQLITE_READONLY", 8],
  ["SQLITE_IOERR", 10], ["SQLITE_CORRUPT", 11], ["SQLITE_CANTOPEN", 14], ["SQLITE_SCHEMA", 17],
  ["SQLITE_MISUSE", 21], ["SQLITE_NOTADB", 26],
]);
function ownData(error: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}
function failure(phase: IdentityPhase, error: unknown, code: LedgerIdentityError["code"] = "invalid_ledger"): LedgerIdentityError {
  let diagnostic: IdentityDiagnostic = { phase, kind: "unknown" };
  try {
    if (error !== null && typeof error === "object" && ownData(error, "name") === "SQLiteError") {
      const sqliteCode = ownData(error, "code"), errno = ownData(error, "errno");
      if (typeof sqliteCode === "string" && typeof errno === "number" && sqliteCodes.get(sqliteCode) === errno) {
        diagnostic = { phase, kind: "sqlite", sqlite_code: sqliteCode, sqlite_errno: errno };
      }
    }
  } catch { /* Uninspectable exception metadata stays unknown. */ }
  return new LedgerIdentityError(code, { cause: error }, diagnostic);
}
function atPhase<T>(phase: IdentityPhase, action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof LedgerIdentityError) throw error;
    throw failure(phase, error);
  }
}

const sidecars = ["kizuki.db-wal", "kizuki.db-shm", "kizuki.db-journal"] as const;

function readIdentity(db: Database): { schemaVersion: number; accepted: number } {
  const tables = atPhase("tables", () => db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_version', 'events', 'event_purges')",
  ).all());
  if (!tables.some(({ name }) => name === "schema_version") || !tables.some(({ name }) => name === "events")) throw new LedgerIdentityError("invalid_ledger", undefined,
    { phase: "tables", kind: "semantic", reason: "missing_tables" });
  const versions = atPhase("version", () => db.query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 2").all());
  if (versions.length !== 1 || !Number.isSafeInteger(versions[0]?.version) || (versions[0]?.version ?? 0) < 1) {
    throw new LedgerIdentityError("invalid_ledger", undefined, { phase: "version", kind: "semantic", reason: "invalid_version" });
  }
  const events = atPhase("transaction", () => db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count);
  const purges = tables.some(({ name }) => name === "event_purges")
    ? atPhase("transaction", () => db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM event_purges").get()?.count)
    : 0;
  const accepted = (events ?? -1) + (purges ?? -1);
  if (!Number.isSafeInteger(accepted) || accepted < 0) {
    throw new LedgerIdentityError("invalid_ledger", undefined, { phase: "transaction", kind: "unknown" });
  }
  return { schemaVersion: versions[0]!.version, accepted };
}

function readAndClose(db: Database): { schemaVersion: number; accepted: number } {
  try { return atPhase("transaction", () => db.transaction(() => readIdentity(db)).deferred()); }
  finally {
    try { db.close(true); }
    catch (error) { throw failure("close", error, "custody_unavailable"); }
  }
}

/** Identity only: callers never receive an immutable database or arbitrary query seam. */
export function inspectLedgerIdentity(vaultPath: string): { schemaVersion: number; accepted: number } {
  const path = join(resolve(vaultPath), ".kizuki", "kizuki.db");
  if (process.platform !== "darwin") {
    try { return readAndClose(atPhase("open", () => new Database(path, { readonly: true }))); }
    catch (error) { throw new LedgerIdentityError("invalid_ledger", { cause: error },
      error instanceof LedgerIdentityError ? error.diagnostic : undefined); }
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
      const result = readAndClose(atPhase("open", () => new Database(path, { readonly: true })));
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
    let result: { schemaVersion: number; accepted: number } | undefined;
    let failure: unknown;
    try {
      result = readAndClose(atPhase("open", () => new Database(`${pathToFileURL(path).href}?immutable=1&mode=ro`,
        constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW)));
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
    throw new LedgerIdentityError("invalid_ledger", { cause: error });
  } finally { directory.close(); }
}
