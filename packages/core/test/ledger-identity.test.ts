import { expect, test } from "bun:test";
import { Database, constants } from "bun:sqlite";
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openLedger } from "../src/ledger/db";
import { inspectLedgerIdentity, LedgerIdentityError } from "../src/ledger/identity";
import { hardenLedgerFile } from "../src/vault/init";
import { initializeEnrollmentLedger } from "./agents/custody-fixture";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-ledger-identity-")), control = join(root, ".kizuki"), path = join(control, "kizuki.db");
  mkdirSync(control, { mode: 0o700 });
  initializeEnrollmentLedger(path);
  return { root, control, path, close() { rmSync(root, { recursive: true, force: true }); } };
}
function observation(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, uid: stat.uid, gid: stat.gid,
    links: stat.nlink, mtime: stat.mtimeNs, ctime: stat.ctimeNs };
}
function closedFootprint(f: ReturnType<typeof fixture>) {
  return { parent: observation(f.control), database: observation(f.path), files: readdirSync(f.control), bytes: readFileSync(f.path) };
}
function beforeIdentityQuery(action: () => void): () => void {
  const original = Database.prototype.query;
  let armed = true;
  Database.prototype.query = function(this: Database, ...args: Parameters<typeof original>) {
    if (armed && args[0].startsWith("SELECT name FROM sqlite_master")) { armed = false; action(); }
    return original.apply(this, args);
  } as typeof original;
  return () => { Database.prototype.query = original; };
}

test("closed ledger identity reads bounded schema and acceptance counts without changing the Darwin ledger", () => {
  const f = fixture(), before = closedFootprint(f), original = Database.prototype.query;
  const queries: string[] = [];
  Database.prototype.query = function(this: Database, ...args: Parameters<typeof original>) {
    queries.push(args[0]); return original.apply(this, args);
  } as typeof original;
  try {
    const identity = inspectLedgerIdentity(f.root);
    expect(Number.isInteger(identity.schemaVersion)).toBe(true);
    expect(identity.schemaVersion).toBeGreaterThan(0);
    expect(identity.accepted).toBe(0);
    expect(Object.keys(identity)).toEqual(["schemaVersion", "accepted"]);
    expect(queries).toHaveLength(4);
    expect(queries[1]).toContain("LIMIT 2");
    if (process.platform === "darwin") expect(closedFootprint(f)).toEqual(before);
  } finally { Database.prototype.query = original; f.close(); }
});

test("identity reads committed WAL frames while another writer remains open", () => {
  const f = fixture(), writer = openLedger(f.path);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0; UPDATE schema_version SET version = 1001");
    hardenLedgerFile(f.path);
    expect(lstatSync(f.path + "-wal").size).toBeGreaterThan(0);
    const mainOnly = new Database(`${pathToFileURL(f.path).href}?immutable=1&mode=ro`,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW);
    try { expect((mainOnly.query("SELECT version FROM schema_version").get() as { version: number }).version).not.toBe(1001); }
    finally { mainOnly.close(true); }
    expect(inspectLedgerIdentity(f.root)).toEqual({ schemaVersion: 1001, accepted: 0 });
    expect(writer.query("SELECT version FROM schema_version").get()).toEqual({ version: 1001 });
  } finally { writer.close(true); f.close(); }
});

test("identity keeps one readonly snapshot when another connection changes the schema between queries", () => {
  const f = fixture(), writer = openLedger(f.path), original = Database.prototype.query;
  let changed = false;
  try {
    const version = (writer.query("SELECT version FROM schema_version").get() as { version: number }).version;
    writer.exec("PRAGMA wal_autocheckpoint = 0; CREATE TABLE identity_snapshot_seed (n INTEGER)");
    hardenLedgerFile(f.path);
    Database.prototype.query = function(this: Database, ...args: Parameters<typeof original>) {
      if (!changed && args[0] === "SELECT version FROM schema_version LIMIT 2") {
        changed = true;
        writer.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE; DROP TABLE events; UPDATE schema_version SET version = 1001; COMMIT");
      }
      return original.apply(this, args);
    } as typeof original;
    expect(inspectLedgerIdentity(f.root)).toEqual({ schemaVersion: version, accepted: 0 });
    expect(changed).toBe(true);
    expect(writer.query("SELECT version FROM schema_version").get()).toEqual({ version: 1001 });
    expect(writer.query("SELECT name FROM sqlite_master WHERE name = 'events'").all()).toEqual([]);
  } finally { Database.prototype.query = original; writer.close(true); f.close(); }
});

for (const kind of ["foreign", "missing-version", "duplicate-version", "zero-version", "unsafe-version"] as const) {
  test(`identity refuses ${kind} without modifying the database`, () => {
    const f = fixture();
    try {
      rmSync(f.path);
      const db = new Database(f.path);
      db.exec(kind === "foreign" ? "CREATE TABLE unrelated (value TEXT)" :
        "CREATE TABLE events (value TEXT); CREATE TABLE schema_version (version INTEGER)" +
        (kind === "duplicate-version" ? "; INSERT INTO schema_version VALUES (1), (2)" : kind === "zero-version" ? "; INSERT INTO schema_version VALUES (0)" :
          kind === "unsafe-version" ? "; INSERT INTO schema_version VALUES (9007199254740992)" : ""));
      db.close(true); chmodSync(f.path, 0o600);
      const before = closedFootprint(f);
      const error = identityFailure(f.root);
      expect(error.diagnostic).toEqual(kind === "foreign"
        ? { phase: "tables", kind: "semantic", reason: "missing_tables" }
        : { phase: "version", kind: "semantic", reason: "invalid_version" });
      expect(closedFootprint(f)).toEqual(before);
    } finally { f.close(); }
  });
}

for (const race of ["live-writer", "writer-closed", "database-metadata", "parent-metadata", "database-replaced", "database-symlink"] as const) {
  test.skipIf(process.platform !== "darwin")(`Darwin immutable identity refuses a raced ${race}`, () => {
    const f = fixture();
    let writer: Database | undefined, raced = false;
    const restore = beforeIdentityQuery(() => {
      raced = true;
      if (race === "live-writer" || race === "writer-closed") {
        writer = openLedger(f.path);
        writer.exec("CREATE TABLE identity_race (n INTEGER); INSERT INTO identity_race VALUES (9)");
        hardenLedgerFile(f.path);
        if (race === "writer-closed") { writer.close(true); writer = undefined; }
      } else if (race === "database-metadata") {
        writeFileSync(f.path, readFileSync(f.path));
      } else if (race === "parent-metadata") {
        writeFileSync(join(f.control, "changed"), "synthetic", { mode: 0o600 });
        rmSync(join(f.control, "changed"));
      } else {
        renameSync(f.path, f.path + ".held");
        if (race === "database-symlink") symlinkSync(f.path + ".held", f.path);
        else { copyFileSync(f.path + ".held", f.path); chmodSync(f.path, 0o600); }
      }
    });
    try {
      let error: unknown;
      try { inspectLedgerIdentity(f.root); } catch (caught) { error = caught; }
      expect(raced).toBe(true);
      expect(error).toBeInstanceOf(LedgerIdentityError);
      expect((error as LedgerIdentityError).code).toBe("busy");
    } finally { restore(); writer?.close(true); f.close(); }
  });
}

for (const alias of ["database-hardlink", "database-symlink", "directory-symlink"] as const) {
  test.skipIf(process.platform !== "darwin")(`Darwin identity refuses an initial ${alias}`, () => {
    const f = fixture();
    try {
      if (alias === "database-hardlink") linkSync(f.path, f.path + ".alias");
      else if (alias === "database-symlink") { renameSync(f.path, f.path + ".held"); symlinkSync(f.path + ".held", f.path); }
      else { renameSync(f.control, f.control + ".held"); symlinkSync(f.control + ".held", f.control); }
      let error: unknown;
      try { inspectLedgerIdentity(f.root); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(LedgerIdentityError);
      expect((error as LedgerIdentityError).code).toBe("custody_unavailable");
    } finally { f.close(); }
  });
}

function identityFailure(root: string): LedgerIdentityError {
  let error: unknown;
  try { inspectLedgerIdentity(root); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(LedgerIdentityError);
  return error as LedgerIdentityError;
}

function sqliteFailure(code: string, errno: number): Error {
  return Object.assign(new Error("synthetic private SQLite text and /private/ledger.db"), { name: "SQLiteError", code, errno });
}

for (const phase of ["tables", "version", "transaction", "close"] as const) {
  test(`identity identifies ${phase} SQLite refusal without exposing exception text`, () => {
    const f = fixture(), originalQuery = Database.prototype.query, originalTransaction = Database.prototype.transaction, originalClose = Database.prototype.close;
    let injected = 0, closed = 0;
    Database.prototype.query = function(this: Database, ...args: Parameters<typeof originalQuery>) {
      if ((phase === "tables" && args[0].startsWith("SELECT name FROM sqlite_master")) ||
          (phase === "version" && args[0] === "SELECT version FROM schema_version LIMIT 2")) {
        injected++; throw sqliteFailure("SQLITE_BUSY", 5);
      }
      return originalQuery.apply(this, args);
    } as typeof originalQuery;
    if (phase === "transaction") Database.prototype.transaction = function() { injected++; throw sqliteFailure("SQLITE_BUSY", 5); } as typeof originalTransaction;
    Database.prototype.close = function(this: Database, ...args: Parameters<typeof originalClose>) {
      closed++; const result = originalClose.apply(this, args);
      if (phase === "close") { injected++; throw sqliteFailure("SQLITE_BUSY", 5); }
      return result;
    };
    try {
      const error = identityFailure(f.root);
      expect(error.diagnostic).toEqual({ phase, kind: "sqlite", sqlite_code: "SQLITE_BUSY", sqlite_errno: 5 });
      expect(Object.isFrozen(error.diagnostic)).toBe(true);
      expect(error.code).toBe(process.platform === "darwin" && phase === "close" ? "custody_unavailable" : "invalid_ledger");
      expect(error.message).toBe(`vault ledger identity is unavailable [phase=${phase} kind=sqlite sqlite_code=SQLITE_BUSY sqlite_errno=5]`);
      expect(injected).toBe(1); expect(closed).toBe(1);
    } finally { Database.prototype.query = originalQuery; Database.prototype.transaction = originalTransaction; Database.prototype.close = originalClose; f.close(); }
  });
}

test("Linux missing file is an actual bounded SQLite open refusal", () => {
  if (process.platform === "darwin") return; // Darwin performs native custody admission before SQLite open.
  const f = fixture();
  try {
    rmSync(f.path);
    const error = identityFailure(f.root);
    expect(error.code).toBe("invalid_ledger");
    expect(error.diagnostic).toEqual({ phase: "open", kind: "sqlite", sqlite_code: "SQLITE_CANTOPEN", sqlite_errno: 14 });
    expect(error.message).not.toContain(f.root);
    expect(readdirSync(f.control)).not.toContain("kizuki.db");
  } finally { f.close(); }
});

for (const shape of ["code-getter", "errno-getter", "name-getter", "inherited", "mismatched-errno", "arbitrary-code", "descriptor-value"] as const) {
  test(`identity diagnostics refuse ${shape} metadata without evaluating unknown getters`, () => {
    const f = fixture(); let getters = 0;
    const failure = sqliteFailure("SQLITE_BUSY", 5);
    Object.defineProperty(failure, "message", { get() { getters++; throw new Error("message getter must not run"); } });
    if (shape.endsWith("-getter")) Object.defineProperty(failure, shape.slice(0, -7), { get() { getters++; return "synthetic private error"; } });
    else if (shape === "inherited") {
      for (const key of ["code", "errno", "name"]) Reflect.deleteProperty(failure, key);
      Object.setPrototypeOf(failure, { name: "SQLiteError", code: "SQLITE_BUSY", errno: 5 });
    } else if (shape === "mismatched-errno") Object.assign(failure, { errno: 14 });
    else if (shape === "arbitrary-code") Object.assign(failure, { code: "SQLITE_private_token", errno: 5 });
    else Object.defineProperty(failure, "code", { get() { getters++; return "SQLITE_BUSY"; } });
    const restore = beforeIdentityQuery(() => { throw failure; });
    const previousValue = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    let error: LedgerIdentityError;
    try {
      if (shape === "descriptor-value") Object.defineProperty(Object.prototype, "value", { value: "SQLITE_BUSY", configurable: true });
      error = identityFailure(f.root);
    } finally {
      if (previousValue) Object.defineProperty(Object.prototype, "value", previousValue); else Reflect.deleteProperty(Object.prototype, "value");
      restore(); f.close();
    }
    expect(getters).toBe(0);
    expect(error.diagnostic).toEqual({ phase: "tables", kind: "unknown" });
    expect(error.message).toBe("vault ledger identity is unavailable [phase=tables kind=unknown]");
  });
}
