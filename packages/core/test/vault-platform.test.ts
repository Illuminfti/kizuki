import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VaultInitError,
  assertVaultControl,
  initVault,
  inspectVaultControl,
} from "../src/vault/init";

const directories: string[] = [];
const moduleUrl = new URL("../src/vault/init.ts", import.meta.url).href;
type Operation = "initVault" | "assertVaultControl" | "inspectVaultControl" | "hardenLedgerFile";

function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), "kizuki-platform-"));
  directories.push(path);
  return path;
}

/** Simulate platform detection in a child, never in the shared test process. */
function expectWindowsRefusal(operation: Operation, path: string, options = {}): void {
  const script = `
    const api = await import(${JSON.stringify(moduleUrl)});
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      api[${JSON.stringify(operation)}](${JSON.stringify(path)}, ${JSON.stringify(options)});
      throw new Error("operation unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof api.VaultInitError)) throw error;
      console.log(JSON.stringify({
        name: error.name, code: error.code, message: error.message,
        inventory: error.inventory ?? null,
      }));
    }
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const refusal = JSON.parse(result.stdout.toString());
  expect(refusal).toMatchObject({
    name: "VaultInitError",
    code: "insecure_permissions",
    inventory: null,
  });
  expect(refusal.message).toContain("Windows (win32) is unsupported");
  expect(refusal.message).toContain("POSIX permissions");
  expect(refusal.message).toContain("Linux or macOS");
  expect(refusal.message).toContain("WSL");
  expect(refusal.message).not.toContain(path);
  expect(refusal.message).not.toMatch(/mode [0-7]{3}/);
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("vault platform refusal (#432)", () => {
  test("native Windows is refused before creating a vault, including adopt and dry run", () => {
    const parent = temporary();
    for (const [index, options] of [{}, { adopt: true }, { dryRun: true }].entries()) {
      const path = join(parent, `new-vault-${index}`);
      expectWindowsRefusal("initVault", path, options);
      expect(existsSync(path)).toBe(false);
    }
    expect(readdirSync(parent)).toEqual([]);
  });

  for (const operation of [
    "initVault", "assertVaultControl", "inspectVaultControl", "hardenLedgerFile",
  ] as const) {
    test(`${operation} refuses Windows without changing an existing vault`, () => {
      const root = temporary();
      const control = join(root, ".kizuki");
      mkdirSync(control, { mode: 0o700 });
      const db = join(control, "kizuki.db");
      const journal = join(control, "init.json");
      const canon = join(root, "CANON.md");
      writeFileSync(db, "synthetic ledger sentinel", { mode: 0o644 });
      writeFileSync(journal, "synthetic journal sentinel", { mode: 0o600 });
      writeFileSync(canon, "synthetic owner doctrine", { mode: 0o600 });
      const files = [db, journal, canon];
      const before = files.map((file) => ({
        bytes: readFileSync(file),
        mode: statSync(file).mode,
      }));
      const rootNames = readdirSync(root).sort();
      const controlNames = readdirSync(control).sort();

      expectWindowsRefusal(operation, operation === "hardenLedgerFile" ? db : root);

      expect(files.map((file) => ({
        bytes: readFileSync(file),
        mode: statSync(file).mode,
      }))).toEqual(before);
      expect(readdirSync(root).sort()).toEqual(rootNames);
      expect(readdirSync(control).sort()).toEqual(controlNames);
    });
  }

  const posixTest = process.platform === "win32" ? test.skip : test;
  posixTest("native POSIX initialization and insecure-mode refusal are unchanged", () => {
    const root = join(temporary(), "vault");
    expect(initVault(root).status).toBe("ready");
    expect(inspectVaultControl(root)).toEqual([]);
    expect(statSync(join(root, ".kizuki")).mode & 0o777).toBe(0o700);
    expect(() => assertVaultControl(root)).not.toThrow();

    chmodSync(join(root, ".kizuki"), 0o777);
    expect(() => assertVaultControl(root)).toThrow(VaultInitError);
    expect(() => assertVaultControl(root)).toThrow("mode 777");
    expect(initVault(root).repaired).toContain(".kizuki/");
    expect(() => assertVaultControl(root)).not.toThrow();
  });
});
