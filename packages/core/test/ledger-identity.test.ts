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

test("closed ledger identity uses two bounded queries and leaves the Darwin ledger unchanged", () => {
  const f = fixture(), before = closedFootprint(f), original = Database.prototype.query;
  const queries: string[] = [];
  Database.prototype.query = function(this: Database, ...args: Parameters<typeof original>) {
    queries.push(args[0]); return original.apply(this, args);
  } as typeof original;
  try {
    const identity = inspectLedgerIdentity(f.root);
    expect(Number.isInteger(identity.schemaVersion)).toBe(true);
    expect(identity.schemaVersion).toBeGreaterThan(0);
    expect(Object.keys(identity)).toEqual(["schemaVersion"]);
    expect(queries).toHaveLength(2);
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
    expect(inspectLedgerIdentity(f.root)).toEqual({ schemaVersion: 1001 });
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
    expect(inspectLedgerIdentity(f.root)).toEqual({ schemaVersion: version });
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
      expect(() => inspectLedgerIdentity(f.root)).toThrow(LedgerIdentityError);
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
