import { expect, test } from "bun:test";
import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderLaunchdPlist } from "../packages/core/src/serve/units";
import { DEFAULT_SERVE_CONFIG } from "../packages/core/src/serve/types";
test("native host preserves private modes, atomic replacement, and directory fsync with spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "native filesystem "));
  try {
    const pending = join(root, "pending"), target = join(root, "target");
    writeFileSync(pending, "new synthetic state", { mode: 0o600 });
    const fd = openSync(pending, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    writeFileSync(target, "old synthetic state", { mode: 0o600 }); renameSync(pending, target);
    const directory = openSync(root, "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("new synthetic state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("native rename replaces a symlink entry without modifying its referent", () => {
  const root = mkdtempSync(join(tmpdir(), "native symlink "));
  try {
    const referent = join(root, "referent");
    const target = join(root, "target");
    const pending = join(root, "pending");
    writeFileSync(referent, "original synthetic state", { mode: 0o600 });
    symlinkSync("referent", target);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    writeFileSync(pending, "replacement synthetic state", { mode: 0o600 });

    renameSync(pending, target);

    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("replacement synthetic state");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(referent, "utf8")).toBe("original synthetic state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test.if(process.platform === "darwin")("native plutil validates launchd rendering without loading a service", () => {
  const root = mkdtempSync(join(tmpdir(), "native launchd "));
  try {
    const path = join(root, "synthetic.plist");
    writeFileSync(path, renderLaunchdPlist({ vaultPath: join(root, "vault"), vaultId: "synthetic", execStart: [join(root, "kizuki"), "serve", "--vault", join(root, "vault")], config: DEFAULT_SERVE_CONFIG }), { mode: 0o600 });
    const result = Bun.spawnSync(["/usr/bin/plutil", "-lint", path], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
