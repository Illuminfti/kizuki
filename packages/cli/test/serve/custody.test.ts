import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHelpers } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

describe("installed service custody boundary", () => {
  for (const mode of ["--service-custody", "--custody-broker-launch", "--custody-broker-child"]) {
    test(`${mode} refuses an ordinary process before opening runtime state`, () => {
      const setup = tempVault(), control = join(setup.vault, ".kizuki");
      const inventory = () => readdirSync(control).sort().map(name => {
        const path = join(control, name), stat = statSync(path);
        return { name, mode: stat.mode, size: stat.size, mtime: stat.mtimeMs,
          bytes: stat.isFile() ? readFileSync(path).toString("base64") : null };
      });
      const before = inventory();
      const result = runCli({ ...setup.env, INVOCATION_ID: "1".repeat(32), MAINPID: String(process.pid) },
        "serve", "--vault", setup.vault, mode, "synthetic-vault");
      // The unit's main process exits 78 on a startup refusal, which its
      // RestartPreventExitStatus never restarts; helper modes keep status 1.
      expect(result.exitCode).toBe(mode === "--service-custody" ? 78 : 1);
      expect(result.stderr).toContain("service_custody_unavailable");
      expect(result.stdout).toBe("");
      expect(inventory()).toEqual(before);
    });
  }

  test("private launch modes cannot combine with public operations", () => {
    const setup = tempVault();
    for (const extra of [["--once"], ["status"], ["--custody-broker-child", "synthetic-vault"]]) {
      const result = runCli(setup.env, "serve", "--vault", setup.vault,
        "--service-custody", "synthetic-vault", ...extra);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("service_custody_unavailable");
    }
    const help = runCli(setup.env, "help", "serve");
    expect(help.stdout).not.toContain("custody");
    const json = runCli(setup.env, "help", "serve", "--json");
    expect(json.exitCode).toBe(0);
    expect(json.stdout).not.toContain("custody");
  });
});

/** Runs the unit's main-process mode in a child whose custody start is a
 * stand-in, so no supervisor, broker or real unit is involved. */
function serviceCustodyMode(vault: string, env: Record<string, string | undefined>, outcome: string): { code: number; text: string } {
  const script = `
    import { mock } from "bun:test";
    import * as internal from "@kizuki/core/internal";
    const outcome = ${JSON.stringify(outcome)};
    mock.module("@kizuki/core/internal", () => ({ ...internal, async startServiceCustody() {
      if (outcome === "held") return Object.freeze({ close() {} });
      throw new internal.ServiceCustodyError(outcome);
    } }));
    const { serveCommand } = await import(${JSON.stringify(resolve(import.meta.dir, "../../src/commands/serve.ts"))});
    const lines = [];
    const io = { env: ${JSON.stringify(env)}, vaultOverride: ${JSON.stringify(vault)}, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
      out: line => lines.push(line), err: line => lines.push(line), prompt: async () => "" };
    const code = await serveCommand.run(io, ["--service-custody", "synthetic-vault"]);
    process.stdout.write(JSON.stringify({ code, text: lines.join("\\n") }));
  `;
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) if (value !== undefined) childEnv[key] = value;
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: resolve(import.meta.dir, "../.."), env: childEnv, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(result.stdout.toString());
}

describe("installed service startup exit status (sandboxed custody stand-in)", () => {
  test("a transient custody failure exits 1; a deterministic refusal exits 78", () => {
    const setup = tempVault();
    expect(serviceCustodyMode(setup.vault, setup.env, "custody_unproven").code).toBe(1);
    const mismatch = serviceCustodyMode(setup.vault, setup.env, "vault_mismatch");
    expect(mismatch.code).toBe(78);
    expect(mismatch.text).toContain(`serve --install --vault ${setup.vault}`);
    expect(serviceCustodyMode(setup.vault, setup.env, "root_user").code).toBe(78);
  }, 60_000);

  test("an older sealed ledger exits 78 in service-custody mode and names the migration", () => {
    const setup = tempVault(), ledgerPath = join(setup.vault, ".kizuki/kizuki.db");
    const oldPath = join(setup.root, "legacy.sqlite"), old = new Database(oldPath);
    try { old.exec(readFileSync(join(import.meta.dir, "../../../core/test/fixtures/doctor-ledger15-legacy.sql"), "utf8")); }
    finally { old.close(true); }
    renameSync(oldPath, ledgerPath); chmodSync(ledgerPath, 0o600);
    writeFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "1\n", { mode: 0o600 });
    const result = serviceCustodyMode(setup.vault, setup.env, "held");
    expect(result.code).toBe(78);
    expect(result.text).toContain("migration_required");
    expect(result.text).toContain(`init ${setup.vault} --no-default --no-service`);
  }, 60_000);
});
