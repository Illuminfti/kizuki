import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksumManifest,
  ensureReleaseDirectory,
  requireAbsent,
  verifyChecksumManifest,
} from "./release-artifacts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-release-test-"));
  directories.push(directory);
  return directory;
}

describe("release artifacts", () => {
  test("refuses a symlinked output directory", () => {
    const root = temp();
    const target = join(root, "target");
    const link = join(root, "release");
    ensureReleaseDirectory(target);
    symlinkSync(target, link);
    expect(() => ensureReleaseDirectory(link)).toThrow("unsafe release directory");
  });

  test("refuses an existing output target", () => {
    const root = temp();
    const target = join(root, "bun-linux-x64-baseline");
    writeFileSync(target, "do not replace\n", "utf8");
    expect(() => requireAbsent(target)).toThrow("refusing to overwrite");
  });

  test("detects tampering with every checksummed package file", () => {
    const release = temp();
    for (const name of ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"]) {
      writeFileSync(join(release, name), `${name}\n`, "utf8");
    }
    const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
    writeFileSync(join(release, "SHA256SUMS"), checksumManifest(release, names), "utf8");
    expect(() => verifyChecksumManifest(release, names)).not.toThrow();
    writeFileSync(join(release, "README.txt"), "changed\n", "utf8");
    expect(() => verifyChecksumManifest(release, names)).toThrow("checksum verification failed");
  });
});
