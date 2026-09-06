import { credentialCustodyQualified } from "./custody-fixture";
import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEnrollmentError, enrollAgent, previewAgentEnrollment } from "../../src/agents/enrollment";
import { openLedger } from "../../src/ledger/db";

function request(destination: string) {
  return {
    operation_id: "preview-0001", name: "preview-agent", token_ref: `file:${destination}`,
    grant: { ceiling: "public" as const, types: [], subjects: [], since: null, until: null, tools: [], rate_limit_per_minute: 60, relay_owner_corrections: false },
  };
}

function fixture(): { vault: string; dbPath: string; credentialDir: string; clean(): void } {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-enrollment-preview-"));
  const control = join(vault, ".kizuki"); mkdirSync(control); chmodSync(control, 0o700);
  const dbPath = join(control, "kizuki.db"); const db = openLedger(dbPath); db.close(true); chmodSync(dbPath, 0o600);
  const credentialDir = mkdtempSync(join(tmpdir(), "kizuki-enrollment-credential-")); chmodSync(credentialDir, 0o700);
  return { vault, dbPath, credentialDir, clean: () => { rmSync(vault, { recursive: true, force: true }); rmSync(credentialDir, { recursive: true, force: true }); } };
}

function footprint(path: string): unknown {
  const stat = lstatSync(path, { bigint: true });
  const content = stat.isDirectory() ? readdirSync(path).sort().map(name => [name, footprint(join(path, name))]) :
    stat.isSymbolicLink() ? readlinkSync(path) : new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
  return { mode: stat.mode.toString(), dev: stat.dev.toString(), ino: stat.ino.toString(), uid: stat.uid.toString(), gid: stat.gid.toString(),
    nlink: stat.nlink.toString(), size: stat.size.toString(), mtime: stat.mtimeNs.toString(), ctime: stat.ctimeNs.toString(), content };
}

describe.if(credentialCustodyQualified)("agent enrollment preview", () => {
  for (const [name, sql] of [
    ["missing ledger index", "DROP INDEX events_occurred_idx"],
    ["missing enrollment table", "DROP TABLE agent_enrollments"],
    ["missing enrollment index", "DROP INDEX agent_enrollments_live_name"],
    ["weakened enrollment guard", "DROP TRIGGER agent_enrollments_block_legacy_agent_insert; CREATE TRIGGER agent_enrollments_block_legacy_agent_insert BEFORE INSERT ON agents BEGIN SELECT 1; END"],
  ] as const) test(`refuses a current version with ${name} without effects`, () => {
    const f = fixture();
    try {
      const db = openLedger(f.dbPath);
      db.exec(sql); db.close(true);
      const before = [footprint(f.vault), footprint(f.credentialDir)];
      let error: unknown;
      try { previewAgentEnrollment(f.vault, request(join(f.credentialDir, "credential.json"))); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(AgentEnrollmentError);
      expect((error as AgentEnrollmentError).code).toBe("enrollment_unavailable");
      expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
    } finally { f.clean(); }
  });

  for (const readFails of [false, true]) test(`normalizes real strict-close failure after ${readFails ? "a failed" : "a successful"} preview read`, () => {
    const f = fixture();
    try {
      const before = [footprint(f.vault), footprint(f.credentialDir)];
      const script = `
        import { Database } from "bun:sqlite";
        const { AgentEnrollmentError, previewAgentEnrollment } = await import(${JSON.stringify(join(import.meta.dir, "../../src/agents/enrollment.ts"))});
        const originalClose = Database.prototype.close, originalPrepare = Database.prototype.prepare;
        const retained = []; let connection, attempts = 0;
        Database.prototype.prepare = function(sql, ...rest) {
          if (${readFails} && sql === "SELECT version FROM schema_version LIMIT 2") throw new Error("synthetic-read-failure");
          return originalPrepare.call(this, sql, ...rest);
        };
        Database.prototype.close = function(...args) {
          attempts++; connection = this;
          // An actual outstanding SQLite statement makes close(true) fail.
          // Retain it through error observation; never rely on GC to release it.
          const statement = originalPrepare.call(this, "SELECT 1 AS close_lifetime_fixture");
          statement.get(); retained.push(statement);
          return originalClose.apply(this, args);
        };
        let typed = false, fixed = false;
        try { previewAgentEnrollment(${JSON.stringify(f.vault)}, ${JSON.stringify(request(join(f.credentialDir, "credential.json")))}); }
        catch (error) { typed = error instanceof AgentEnrollmentError; fixed = typed && error.code === "enrollment_unavailable" && error.message === "enrollment_unavailable"; }
        finally {
          Database.prototype.close = originalClose; Database.prototype.prepare = originalPrepare;
          for (const statement of retained) statement.finalize();
          if (connection !== undefined) originalClose.call(connection, true);
        }
        console.log(JSON.stringify({ typed, fixed, attempts }));
      `;
      const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(child.exitCode).toBe(0); expect(child.stderr.length).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({ typed: true, fixed: true, attempts: 1 });
      expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
    } finally { f.clean(); }
  });

  for (const destination of [
    ".", "..notes/credential", "notes/credential", ".kizuki", ".kizuki/agent-credentials",
    ".kizuki/kizuki.db", ".kizuki/kizuki.db-wal", ".kizuki/kizuki.db-shm", ".kizuki/kizuki.db-journal",
    ".kizuki/config.json", ".kizuki/serve/token", ".kizuki/retrieval/credential",
    ".kizuki/agent-credentials/nested/credential",
  ]) test(`refuses in-vault destination ${destination} before any effect`, () => {
    const f = fixture();
    try {
      const before = [footprint(f.vault), footprint(f.credentialDir)];
      for (const run of [previewAgentEnrollment, enrollAgent]) {
        expect(() => run(f.vault, request(join(f.vault, destination)))).toThrow("credential_unsafe");
        expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
      }
    } finally { f.clean(); }
  });

  test("requires an existing private credential namespace and allows only its direct files", () => {
    const f = fixture(), directory = join(f.vault, ".kizuki/agent-credentials");
    const input = request(join(directory, "credential"));
    try {
      const before = footprint(f.vault);
      for (const run of [previewAgentEnrollment, enrollAgent]) {
        expect(() => run(f.vault, input)).toThrow("credential_unsafe");
        expect(footprint(f.vault)).toEqual(before);
      }
      mkdirSync(directory, { mode: 0o700 });
      const initialized = footprint(f.vault);
      expect(previewAgentEnrollment(f.vault, input).status).toBe("preview");
      expect(footprint(f.vault)).toEqual(initialized);
      expect(enrollAgent(f.vault, input)).toMatchObject({ status: "completed", authority: "active", credential: "ready" });
      const db = openLedger(f.dbPath); expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 1 }); db.close();
    } finally { f.clean(); }
  });

  test("refuses a symlinked or replaced credential namespace without adopting its files", () => {
    const f = fixture(), directory = join(f.vault, ".kizuki/agent-credentials");
    const input = request(join(directory, "credential"));
    try {
      symlinkSync(f.credentialDir, directory);
      let before = [footprint(f.vault), footprint(f.credentialDir)];
      for (const run of [previewAgentEnrollment, enrollAgent]) expect(() => run(f.vault, input)).toThrow("credential_unsafe");
      expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
      rmSync(directory); mkdirSync(directory, { mode: 0o700 });
      expect(enrollAgent(f.vault, input).credential).toBe("ready");
      renameSync(directory, join(f.vault, ".kizuki/old-credentials"));
      mkdirSync(directory, { mode: 0o700 });
      before = [footprint(f.vault), footprint(f.credentialDir)];
      expect(() => previewAgentEnrollment(f.vault, input)).toThrow("operation_conflict");
      expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
      expect(() => enrollAgent(f.vault, input)).toThrow("operation_conflict");
      expect(readdirSync(directory)).toEqual([]);
    } finally { f.clean(); }
  });

  for (const name of ["kizuki.db", "kizuki.db-wal", "kizuki.db-shm", "kizuki.db-journal"]) {
    test(`reserves SQLite basename ${name} even in an external private directory`, () => {
      const f = fixture();
      try {
        const before = [footprint(f.vault), footprint(f.credentialDir)];
        for (const run of [previewAgentEnrollment, enrollAgent]) {
          expect(() => run(f.vault, request(join(f.credentialDir, name)))).toThrow("credential_unsafe");
          expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
        }
      } finally { f.clean(); }
    });
  }

  test("observes malformed current grants without quarantining or misclassifying intact credentials", () => {
    const f = fixture(), input = request(join(f.credentialDir, "credential"));
    try {
      const enrolled = enrollAgent(f.vault, input);
      expect(enrolled.credential).toBe("ready");
      const db = openLedger(f.dbPath);
      db.exec("PRAGMA ignore_check_constraints=ON");
      db.query("UPDATE agent_grants SET tools='not-json' WHERE agent_id=?").run(enrolled.agent_id);
      db.close(true);
      // SQLite closes naturally; no journal removal manufactures preview success.
      expect(readdirSync(join(f.vault, ".kizuki"))).toEqual(["kizuki.db"]);
      const before = [footprint(f.vault), footprint(f.credentialDir)];
      expect(previewAgentEnrollment(f.vault, input)).toMatchObject({ status: "completed", authority: "unavailable", credential: "stale", grant: null });
      expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
      expect(enrollAgent(f.vault, input)).toMatchObject({ status: "completed", authority: "unavailable", credential: "stale", grant: null });
      const reopened = openLedger(f.dbPath);
      expect(reopened.query("SELECT quarantined_at FROM agents WHERE agent_id=?").get(enrolled.agent_id)).toEqual({ quarantined_at: null });
      expect(reopened.query("SELECT tools FROM agent_grants WHERE agent_id=?").get(enrolled.agent_id)).toEqual({ tools: "not-json" });
      reopened.close();
    } finally { f.clean(); }
  });

  test("reads a current initialized ledger without changing it", () => {
    const f = fixture();
    try {
      const before = [footprint(f.vault), footprint(f.credentialDir)];
      expect(previewAgentEnrollment(f.vault, request(join(f.credentialDir, "credential.json")))).toMatchObject({ status: "preview", authority: "none", credential: "absent" });
      expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
    } finally { f.clean(); }
  });

  test("reports migration_required without writing an old ledger", () => {
    const f = fixture();
    try {
      const db = openLedger(f.dbPath); db.query("UPDATE schema_version SET version = 16").run(); db.close();
      const before = [footprint(f.vault), footprint(f.credentialDir)];
      expect(() => previewAgentEnrollment(f.vault, request(join(f.credentialDir, "credential.json")))).toThrow(AgentEnrollmentError);
      try { previewAgentEnrollment(f.vault, request(join(f.credentialDir, "credential.json"))); } catch (error) { expect((error as AgentEnrollmentError).code).toBe("migration_required"); }
      expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
    } finally { f.clean(); }
  });

  test("percent-encodes spaces and URI delimiters without creating sidecars", () => {
    const f = fixture(), renamed = `${f.vault} # preview?`;
    renameSync(f.vault, renamed);
    try {
      const before = footprint(renamed);
      expect(previewAgentEnrollment(renamed, request(join(f.credentialDir, "credential.json"))).status).toBe("preview");
      expect(footprint(renamed)).toEqual(before);
    } finally { renameSync(renamed, f.vault); f.clean(); }
  });

  test("refuses committed WAL left by a killed process without changing any bytes", () => {
    const f = fixture();
    try {
      const script = `
        import { openLedger } from ${JSON.stringify(join(import.meta.dir, "../../src/ledger/db.ts"))};
        const db = openLedger(${JSON.stringify(f.dbPath)});
        db.exec("CREATE TABLE preview_wal_fixture (n INTEGER); INSERT INTO preview_wal_fixture VALUES (1)");
        process.stdout.write("committed\\n"); process.kill(process.pid, "SIGKILL");
      `;
      const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(child.exitCode).not.toBe(0); expect(child.stdout.toString()).toBe("committed\n"); expect(child.stderr.length).toBe(0);
      expect(lstatSync(`${f.dbPath}-wal`).size).toBeGreaterThan(0);
      const before = [footprint(f.vault), footprint(f.credentialDir)];
      expect(() => previewAgentEnrollment(f.vault, request(join(f.credentialDir, "credential.json")))).toThrow("enrollment_busy");
      expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
    } finally { f.clean(); }
  });

  test("refuses an unsafe sidecar before SQLite can touch its target", () => {
    const f = fixture();
    try {
      const target = join(f.credentialDir, "unrelated"); writeFileSync(target, "preserve unrelated bytes", { mode: 0o600 });
      symlinkSync(target, `${f.dbPath}-shm`);
      const before = [footprint(f.vault), footprint(f.credentialDir)];
      expect(() => previewAgentEnrollment(f.vault, request(join(f.credentialDir, "credential.json")))).toThrow("vault_unavailable");
      expect([footprint(f.vault), footprint(f.credentialDir)]).toEqual(before);
    } finally { f.clean(); }
  });

  for (const altered of ["main", "parent"] as const) {
    test(`rejects ${altered} metadata changed after readonly close before releasing preview`, () => {
      const f = fixture();
      try {
        const script = `
          import { Database } from "bun:sqlite";
          import { utimesSync } from "node:fs";
          import { dirname } from "node:path";
          import { strict as assert } from "node:assert";
          const original = Database.prototype.close;
          let changed = false;
          Database.prototype.close = function(...args) {
            const result = original.apply(this, args);
            if (!changed) { changed = true; utimesSync(${altered === "main" ? JSON.stringify(f.dbPath) : `dirname(${JSON.stringify(f.dbPath)})`}, new Date("2001-01-01"), new Date("2002-01-01")); }
            return result;
          };
          const { previewAgentEnrollment } = await import(${JSON.stringify(join(import.meta.dir, "../../src/agents/enrollment.ts"))});
          assert.throws(() => previewAgentEnrollment(${JSON.stringify(f.vault)}, ${JSON.stringify(request(join(f.credentialDir, "credential.json")))}), { message: "enrollment_busy" });
          assert.equal(changed, true);
        `;
        const before = readFileSync(f.dbPath);
        const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
        expect(child.exitCode).toBe(0); expect(child.stdout.length).toBe(0); expect(child.stderr.length).toBe(0);
        expect(readFileSync(f.dbPath).equals(before)).toBe(true);
        expect(readdirSync(f.credentialDir)).toEqual([]);
      } finally { f.clean(); }
    });
  }
});

test.if(process.platform === "linux" && process.arch === "x64")("reports missing native custody support independently of path safety", () => {
  const script = `
    import { mock } from "bun:test";
    let loads = 0;
    mock.module(${JSON.stringify(join(import.meta.dir, "../../src/util/owned-directory-native.ts"))}, () => ({
      loadOwnedDirectoryNative() { loads++; throw new Error("synthetic-native-loader-failure"); },
    }));
    const { AgentEnrollmentError, previewAgentEnrollment, enrollAgent, revokeAgentEnrollment } = await import(${JSON.stringify(join(import.meta.dir, "../../src/agents/enrollment.ts"))});
    const input = ${JSON.stringify(request("/synthetic/private/credential.json"))};
    const codes = [];
    for (const operation of [
      () => previewAgentEnrollment("/synthetic/vault", input),
      () => enrollAgent("/synthetic/vault", input),
      () => revokeAgentEnrollment("/synthetic/vault", input.name),
    ]) {
      try { operation(); codes.push(null); }
      catch (error) { codes.push(error instanceof AgentEnrollmentError ? error.code : null); }
    }
    console.log(JSON.stringify({ loads, codes }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  expect(child.exitCode).toBe(0); expect(child.stderr.length).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ loads: 3, codes: ["unsupported_platform", "unsupported_platform", "unsupported_platform"] });
});
