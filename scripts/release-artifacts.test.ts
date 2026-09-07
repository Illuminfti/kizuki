import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_PACKAGE_FILES, packageFiles, parseBuildInfo, parseBuildInfoValue, verifyPackageDirectory,
  checksumManifest,
  ensureReleaseDirectory,
  requireAbsent,
  verifyChecksumManifest,
} from "./release-artifacts";

import { writePackageFixture } from "./release-package-fixture";

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

test.each([false, true])("new seven-file package verifies material bytes with completeness %s", complete => {
  const root = temp(), build = writePackageFixture(root, undefined, undefined, complete);
  expect(packageFiles(build)).toEqual(CURRENT_PACKAGE_FILES);
  expect(parseBuildInfo(join(root, "BUILD.json"))).toEqual(build);
  expect(() => verifyPackageDirectory(root, build)).not.toThrow();
});
test.each([...CURRENT_PACKAGE_FILES])("every new member %s is required", name => {
  const root = temp(), build = writePackageFixture(root); rmSync(join(root, name));
  expect(() => verifyPackageDirectory(root, build)).toThrow();
});
test.each(["LICENSE", "THIRD-PARTY-NOTICES.txt"])("notice tampering survives checksum rewrite but fails bound BUILD identity: %s", name => {
  const root = temp(), build = writePackageFixture(root); writeFileSync(join(root, name), "changed original text");
  writeFileSync(join(root, "SHA256SUMS"), checksumManifest(root, CURRENT_PACKAGE_FILES.slice(0, -1)));
  expect(() => verifyPackageDirectory(root, build)).toThrow("invalid package distribution identity");
});
test.each(["extra", "symlink", "hardlink", "reorder", "newline"])("new package refuses %s custody or manifest drift", mode => {
  const root = temp(), build = writePackageFixture(root);
  if (mode === "extra") writeFileSync(join(root, "extra"), "unexpected");
  if (mode === "symlink" || mode === "hardlink") {
    rmSync(join(root, "LICENSE"));
    if (mode === "symlink") symlinkSync(join(root, "README.txt"), join(root, "LICENSE"));
    else linkSync(join(root, "README.txt"), join(root, "LICENSE"));
  }
  if (mode === "reorder") writeFileSync(join(root, "SHA256SUMS"), checksumManifest(root, [...CURRENT_PACKAGE_FILES.slice(0, -1)].reverse()));
  if (mode === "newline") appendFileSync(join(root, "SHA256SUMS"), "\n");
  expect(() => verifyPackageDirectory(root, build)).toThrow();
});
test("BUILD refuses duplicate keys and unknown fields", () => {
  const root = temp(); writePackageFixture(root);
  const raw = readFileSync(join(root, "BUILD.json"), "utf8");
  writeFileSync(join(root, "BUILD.json"), '{"schema":"kizuki.release-build/v2",' + raw.slice(1));
  expect(() => parseBuildInfo(join(root, "BUILD.json"))).toThrow("duplicate-json-key");
  expect(() => parseBuildInfoValue({ ...JSON.parse(raw), legal_approval: true })).toThrow();
});
