import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHelpers, fixtureConsent } from "./helpers";
import { fakeSystemd } from "./serve/supervisor-fixture";

// Compiles two fixture packages and spawns their binaries; bound for a loaded host.
setDefaultTimeout(120_000);

const main = resolve(import.meta.dir, "../src/main.ts");
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const h = createHelpers();
afterAll(h.cleanup);

/** One fixture package directory holding a compiled `kizuki`, as `docs/upgrade.md` stages it. */
function stagePackage(installRoot: string, name: string, sha: string): string {
  const directory = join(installRoot, name);
  mkdirSync(directory, { recursive: true });
  const define = { KIZUKI_COMPILED: "true", KIZUKI_BUILD_SHA: JSON.stringify(sha), KIZUKI_BUILD_TIME: JSON.stringify("2026-01-02T03:04:05.000Z") };
  const flags = Object.entries(define).flatMap(([key, value]) => ["--define", `${key}=${value}`]);
  const compiled = Bun.spawnSync([process.execPath, "build", main, "--compile", "--outfile", join(directory, "kizuki"),
    "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", ...flags], { stdout: "pipe", stderr: "pipe" });
  if (compiled.exitCode !== 0) throw new Error(`fixture package build failed: ${compiled.stderr.toString()}`);
  return directory;
}

const sqlite3 = Bun.which("sqlite3");
const root = h.tempDir("kizuki-upgrade-");
const installRoot = join(root, "install");
const vault = join(root, "vault");
const notes = join(root, "notes");
const backup = join(root, "backup");
const oldPackage = join(installRoot, "kizuki-1.0.0");
const newPackage = join(installRoot, "kizuki-1.0.1");
const env = {
  ...fakeSystemd(root, h.isolatedEnv({ HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"), KIZUKI_CONFIG: join(root, "config.toml") })),
  KIZUKI_SUPERVISOR: "systemd",
} as Record<string, string | undefined>;

function run(package_: string, ...args: string[]): { code: number; out: string; err: string } {
  const spawnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ PATH: process.env.PATH, ...env })) if (value !== undefined) spawnEnv[key] = value;
  const result = Bun.spawnSync([join(package_, "kizuki"), ...args], { env: spawnEnv, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}
/** `cp -a`: the restored tree must keep its owner-only modes, which a plain recursive copy does not. */
function copyAll(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  const copied = Bun.spawnSync(["cp", "-a", `${from}/.`, to], { stdout: "pipe", stderr: "pipe" });
  if (copied.exitCode !== 0) throw new Error(`cp -a failed: ${copied.stderr.toString()}`);
}
function ok(package_: string, ...args: string[]): string {
  const result = run(package_, ...args);
  if (result.code !== 0) throw new Error(`${args.join(" ")} exited ${result.code}: ${result.err}`);
  return result.out;
}
function serviceUnit(): string {
  return `kizuki@${readFileSync(join(vault, ".kizuki", "vault-id"), "utf8").trim()}.service`;
}
/** The executable the installed user service will start. */
function serviceExecutable(): string {
  const line = readFileSync(join(root, "xdg", "systemd", "user", serviceUnit()), "utf8").split("\n").find(row => row.startsWith("ExecStart="));
  return line!.slice("ExecStart=".length).split(" ")[0]!.replaceAll('"', "");
}

beforeAll(() => {
  stagePackage(installRoot, "kizuki-1.0.0", OLD_SHA);
  h.writeNotes(notes);
});

test("upgrading an installed package in place moves the service to the new build and rolls back to the old one", () => {
  if (sqlite3 === null) throw new Error("the upgrade runbook needs the sqlite3 shell");
  // The installed baseline: a vault created by the old package, service pointing at it.
  expect(ok(oldPackage, "version")).toBe(`1.0.2 source=${OLD_SHA} built=2026-01-02T03:04:05.000Z\n`);
  ok(oldPackage, "init", vault);
  ok(oldPackage, "import", "markdown-folder", "--source", notes, "--vault", vault, ...fixtureConsent(root));
  expect(ok(oldPackage, "query", "acme", "--vault", vault)).toContain("ada met grace");
  expect(serviceExecutable()).toBe(join(oldPackage, "kizuki"));

  // Runbook step 1: stage the new version next to the old one; the old directory is untouched.
  stagePackage(installRoot, "kizuki-1.0.1", NEW_SHA);
  expect(existsSync(join(oldPackage, "kizuki"))).toBe(true);
  expect(ok(newPackage, "version")).toBe(`1.0.2 source=${NEW_SHA} built=2026-01-02T03:04:05.000Z\n`);
  expect(serviceExecutable()).toBe(join(oldPackage, "kizuki"));

  // Runbook step 2: file-level backup, database through sqlite3 .backup.
  copyAll(vault, backup);
  Bun.spawnSync(["sh", "-c", 'rm -f "$1"/.kizuki/kizuki.db "$1"/.kizuki/kizuki.db-wal "$1"/.kizuki/kizuki.db-shm && find "$1" -name "*.sock" -delete', "sh", backup]);
  const snapshot = Bun.spawnSync([sqlite3, `file:${join(vault, ".kizuki", "kizuki.db")}?mode=ro`, `.backup '${join(backup, ".kizuki", "kizuki.db")}'`], { stdout: "pipe", stderr: "pipe" });
  expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0);
  chmodSync(join(backup, ".kizuki", "kizuki.db"), 0o600);
  const check = Bun.spawnSync([sqlite3, join(backup, ".kizuki", "kizuki.db"), "pragma integrity_check;"], { stdout: "pipe" });
  expect(check.stdout.toString().trim()).toBe("ok");

  // Runbook steps 3 to 5: stop the old service, install from the new real path, verify.
  ok(oldPackage, "serve", "--uninstall", "--vault", vault);
  expect(existsSync(join(root, "xdg", "systemd", "user", serviceUnit()))).toBe(false);
  ok(newPackage, "serve", "--install", "--vault", vault);
  expect(serviceExecutable()).toBe(join(newPackage, "kizuki"));
  expect(ok(newPackage, "query", "acme", "--vault", vault)).toContain("ada met grace");
  // The synthetic supervisor runs no rails, so overall health stays red; the ledger check is what an upgrade must keep green.
  expect((JSON.parse(run(newPackage, "doctor", "--json", "--vault", vault).out) as { data: { ledger: { ok: boolean } } }).data.ledger.ok).toBe(true);

  // Runbook step 6, light rollback: swap the service back to the old package, data untouched.
  ok(newPackage, "serve", "--uninstall", "--vault", vault);
  ok(oldPackage, "serve", "--install", "--vault", vault);
  expect(serviceExecutable()).toBe(join(oldPackage, "kizuki"));
  expect(ok(oldPackage, "query", "acme", "--vault", vault)).toContain("ada met grace");

  // Runbook step 6, full rollback: work captured after the upgrade is discarded with the vault, the backup is restored in place.
  ok(oldPackage, "serve", "--uninstall", "--vault", vault);
  ok(newPackage, "serve", "--install", "--vault", vault);
  writeFileSync(join(notes, "after-upgrade.md"), "hopper filed the copper-tide report\n");
  ok(newPackage, "import", "markdown-folder", "--source", notes, "--vault", vault);
  expect(ok(newPackage, "query", "copper-tide", "--vault", vault)).toContain("hopper filed");
  ok(newPackage, "serve", "--uninstall", "--vault", vault);
  renameSync(vault, join(root, "vault.failed"));
  copyAll(backup, vault);
  ok(oldPackage, "serve", "--install", "--vault", vault);
  expect(serviceExecutable()).toBe(join(oldPackage, "kizuki"));
  expect(ok(oldPackage, "query", "acme", "--vault", vault)).toContain("ada met grace");
  expect(ok(oldPackage, "query", "copper-tide", "--vault", vault)).not.toContain("hopper filed");
  expect(readFileSync(join(vault, ".kizuki", "vault-id"), "utf8")).toBe(readFileSync(join(root, "vault.failed", ".kizuki", "vault-id"), "utf8"));
});
