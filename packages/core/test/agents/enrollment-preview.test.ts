import { credentialCustodyQualified } from "./custody-fixture";
import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEnrollmentError, previewAgentEnrollment } from "../../src/agents/enrollment";
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
  const dbPath = join(control, "kizuki.db"); const db = openLedger(dbPath); db.close(); chmodSync(dbPath, 0o600);
  const credentialDir = mkdtempSync(join(tmpdir(), "kizuki-enrollment-credential-")); chmodSync(credentialDir, 0o700);
  return { vault, dbPath, credentialDir, clean: () => { rmSync(vault, { recursive: true, force: true }); rmSync(credentialDir, { recursive: true, force: true }); } };
}

function footprint(path: string): unknown {
  const stat = lstatSync(path, { bigint: true });
  const content = stat.isDirectory() ? readdirSync(path).sort().map(name => [name, footprint(join(path, name))]) :
    stat.isSymbolicLink() ? readlinkSync(path) : new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
  return { mode: stat.mode.toString(), ino: stat.ino.toString(), mtime: stat.mtimeNs.toString(), ctime: stat.ctimeNs.toString(), content };
}

describe.if(credentialCustodyQualified)("agent enrollment preview", () => {
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
