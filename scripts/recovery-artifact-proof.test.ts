import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecoveryArgs } from "./recovery-artifact-proof";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("recovery invocation exposes no source, actor, outcome, skip or timeout overrides", () => {
  expect(parseRecoveryArgs(["--artifact", "/tmp/package", "--out", "/tmp/new-proof"])).toEqual({ artifact: "/tmp/package", out: "/tmp/new-proof" });
  for (const args of [[], ["--artifact", "relative", "--out", "/tmp/new"], ["--artifact", "/tmp/package", "--out", "/tmp/../new"],
    ["--artifact", "/tmp/package", "--out", "/tmp/new", "--out", "/tmp/another"],
    ...["--source", "--passed", "--owner", "--skip", "--timeout"].map(flag => ["--artifact", "/tmp/package", "--out", "/tmp/new", flag, "true"])]) expect(() => parseRecoveryArgs(args)).toThrow();
});
test("a preflight refusal retains one private failed attempt without issuing a native receipt or replacing history", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-recovery-refusal-")); roots.push(root); const out = join(root, "attempt");
  const argv = [process.execPath, join(import.meta.dir, "recovery-artifact-proof.ts"), "--artifact", join(root, "missing-token-canary"), "--out", out];
  const first = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 30000 });
  expect(first.exitCode).toBe(1); expect(first.stdout.toString()).toBe(""); expect(first.stderr.toString()).not.toContain("token-canary");
  expect(readdirSync(out).sort()).toEqual(["attempt.json", "failure.json"]); expect(existsSync(join(out, "receipt.json"))).toBe(false);
  const retained = readFileSync(join(out, "failure.json")); expect(statSync(out).mode & 0o777).toBe(0o700);
  for (const file of ["attempt.json", "failure.json"]) expect(statSync(join(out, file)).mode & 0o777).toBe(0o600);
  const retry = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 30000 }); expect(retry.exitCode).toBe(1); expect(readFileSync(join(out, "failure.json"))).toEqual(retained);
  const link = join(root, "linked-output"); symlinkSync(out, link, "dir");
  const unsafe = Bun.spawnSync([...argv.slice(0, -1), link], { stdout: "pipe", stderr: "pipe", timeout: 30000 }); expect(unsafe.exitCode).toBe(1); expect(readFileSync(join(out, "failure.json"))).toEqual(retained);
});
