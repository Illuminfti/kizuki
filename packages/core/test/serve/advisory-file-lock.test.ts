import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tryAdvisoryFileLock } from "../../src/util/advisory-file-lock";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "native lock ")); roots.push(root); return root; }
test("native advisory lock preserves inode and identity-bound idempotent release", () => {
  const path = join(fixture(), "held.lock"); const first = tryAdvisoryFileLock(path)!;
  expect(first).not.toBeNull(); const inode = statSync(path).ino;
  expect(tryAdvisoryFileLock(path)).toBeNull(); first.release();
  const second = tryAdvisoryFileLock(path)!; first.release();
  expect(tryAdvisoryFileLock(path)).toBeNull(); expect(statSync(path).ino).toBe(inode); second.release();
});
test("native advisory lock refuses symlink and hardlink aliases", () => {
  const root = fixture(), actual = join(root, "actual"); writeFileSync(actual, "");
  symlinkSync(actual, join(root, "symbolic"));
  expect(() => tryAdvisoryFileLock(join(root, "symbolic"))).toThrow();
  linkSync(actual, join(root, "hard"));
  expect(() => tryAdvisoryFileLock(join(root, "hard"))).toThrow();
});
test("actual child death releases kernel ownership on the unchanged inode", async () => {
  const path = join(fixture(), "held.lock"), module = fileURLToPath(new URL("../../src/util/advisory-file-lock.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "--eval", `const {tryAdvisoryFileLock}=await import(${JSON.stringify(module)}); const lock=tryAdvisoryFileLock(${JSON.stringify(path)}); if(!lock)process.exit(2); console.log('held'); await Bun.stdin.text();`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain("held"); reader.releaseLock();
    const inode = statSync(path).ino; expect(tryAdvisoryFileLock(path)).toBeNull();
    child.kill("SIGKILL"); await child.exited;
    const recovered = tryAdvisoryFileLock(path); expect(recovered).not.toBeNull(); expect(statSync(path).ino).toBe(inode); recovered!.release();
  } finally { child.kill(); await child.exited; }
});
