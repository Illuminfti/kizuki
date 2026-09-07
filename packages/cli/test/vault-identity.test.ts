import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempDir, tempVault } = createHelpers();
afterEach(cleanup);

describe("vault identity", () => {
  test("a directory is not a vault just because it exists", () => {
    const env = isolatedEnv();
    const decoy = join(tempDir(), "decoy");
    mkdirSync(decoy, { recursive: true });
    const result = runCli({ ...env, KIZUKI_VAULT: decoy }, "doctor");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("vault is not initialized");
  });

  test("a .kizuki folder without vault-id is refused", () => {
    const env = isolatedEnv();
    const decoy = join(tempDir(), "half");
    mkdirSync(join(decoy, ".kizuki"), { recursive: true });
    mkdirSync(join(decoy, "archive"), { recursive: true });
    const result = runCli({ ...env, KIZUKI_VAULT: decoy }, "doctor");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("vault identity missing");
  });

  test("init writes a vault-id that later commands accept", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "vault");
    expect(runCli(env, "init", vault, "--no-service").exitCode).toBe(0);
    const doctor = runCli({ ...env, KIZUKI_VAULT: vault }, "doctor");
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain("vault_id=");
  });
});

for (const code of ["SQLITE_BUSY", "SQLITE_CANTOPEN", "unknown-getters"] as const) {
  test(`public writer refuses ${code} with a closed diagnostic and no reinitialization advice`, () => {
    const setup = tempVault(), preload = join(setup.root, "identity-fault.ts"), trace = join(setup.root, "identity-trace.json");
    writeFileSync(preload, `
      import { Database } from "bun:sqlite";
      import { writeFileSync } from "node:fs";
      let getters = 0, injected = 0;
      const original = Database.prototype.query;
      Database.prototype.query = function(...args) {
        if (args[0].startsWith("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN")) {
          injected++;
          const failure = new Error("synthetic-private-SQL-and-token /private/ledger.db");
          Object.assign(failure, { name: "SQLiteError", code: ${JSON.stringify(code)}, errno: ${code === "SQLITE_CANTOPEN" ? 14 : 5} });
          if (${JSON.stringify(code)} === "unknown-getters") {
            for (const name of ["code", "errno", "message"]) Object.defineProperty(failure, name, { get() { getters++; return "private-getter-value"; } });
          }
          throw failure;
        }
        return original.apply(this, args);
      };
      process.on("exit", () => writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ getters, injected })));
    `);
    const result = Bun.spawnSync([process.execPath, "--preload", preload, resolve(import.meta.dir, "../src/main.ts"), "rebuild"], {
      env: { ...process.env, ...setup.env }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("error: vault ledger identity is unavailable [phase=tables kind=" +
      (code === "unknown-getters" ? "unknown" : `sqlite sqlite_code=${code} sqlite_errno=${code === "SQLITE_BUSY" ? 5 : 14}`) + "]\n");
    expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual({ getters: 0, injected: 1 });
    expect(runCli(setup.env, "doctor").exitCode).toBe(0);
  });
}

for (const reason of ["missing_tables", "invalid_version"] as const) {
  test(`public writer keeps init guidance only for confirmed ${reason}`, () => {
    const setup = tempVault(), path = join(setup.vault, ".kizuki", "kizuki.db");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
    const foreign = new Database(path);
    foreign.exec(reason === "missing_tables" ? "CREATE TABLE unrelated (value TEXT)" :
      "CREATE TABLE events (value TEXT); CREATE TABLE schema_version (version INTEGER)");
    foreign.close(true); chmodSync(path, 0o600);
    const result = runCli(setup.env, "rebuild");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("vault ledger is not a Kizuki database or has no usable schema version");
    expect(result.stderr).toContain("run: kizuki init");
    expect(result.stderr).toContain(`kind=semantic reason=${reason}`);
  });
}
