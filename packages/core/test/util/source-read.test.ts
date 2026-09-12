import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSourceChild, SourceReadError } from "../../src/util/source-read";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const supported = (process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-source-read-"));
  roots.push(root);
  const nested = join(root, "nested"), outside = join(root, "outside");
  mkdirSync(nested); mkdirSync(outside);
  writeFileSync(join(nested, "inside.md"), "inside\n");
  writeFileSync(join(outside, "inside.md"), "MUST_NOT_CAPTURE\n");
  writeFileSync(join(outside, "leak.md"), "MUST_NOT_CAPTURE\n");
  return { root, nested, outside };
}
function readChild(parentFd: number, name: string): string {
  const fd = openSourceChild(parentFd, name);
  try {
    const info = fstatSync(fd);
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("short source-read");
      offset += count;
    }
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}

test.skipIf(!supported)("openat of a held parent still reads the original child after the path is replaced", () => {
  const f = fixture();
  const parent = openSync(f.nested, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    renameSync(f.nested, join(f.root, "nested.replaced"));
    renameSync(f.outside, f.nested);
    expect(readChild(parent, "inside.md")).toBe("inside\n");
  } finally { closeSync(parent); }
});

test.skipIf(!supported)("a symlink child is refused without following it", () => {
  const f = fixture();
  symlinkSync(join(f.outside, "inside.md"), join(f.nested, "link.md"));
  const parent = openSync(f.nested, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    expect(() => openSourceChild(parent, "link.md")).toThrow(SourceReadError);
    try { openSourceChild(parent, "link.md"); }
    catch (error) {
      expect(error).toBeInstanceOf(SourceReadError);
      expect((error as SourceReadError).reason).toBe("symlink");
    }
  } finally { closeSync(parent); }
});

test.skipIf(!supported)("group-writable source directories and files remain readable", () => {
  const f = fixture();
  chmodSync(f.nested, 0o775);
  chmodSync(join(f.nested, "inside.md"), 0o664);
  const parent = openSync(f.nested, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { expect(readChild(parent, "inside.md")).toBe("inside\n"); }
  finally { closeSync(parent); }
});

test.skipIf(supported)("unsupported platforms refuse without a pathname", () => {
  expect(() => openSourceChild(0, "inside.md")).toThrow(SourceReadError);
  try { openSourceChild(0, "inside.md"); }
  catch (error) {
    expect(error).toBeInstanceOf(SourceReadError);
    expect((error as SourceReadError).reason).toBe("unsupported");
  }
});

test.skipIf(!supported)("native unavailability refuses without a pathname fallback", async () => {
  const nativeModule = join(import.meta.dir, "../../src/util/owned-directory-native.ts");
  const sourceModule = join(import.meta.dir, "../../src/util/source-read.ts");
  const child = Bun.spawn([
    process.execPath,
    "--eval",
    `
      import { mock } from "bun:test";
      import { strict as assert } from "node:assert";
      mock.module(${JSON.stringify(nativeModule)}, () => ({
        loadOwnedDirectoryNative() { throw new Error("owned_directory_native_unavailable"); },
      }));
      const { openSourceChild, SourceReadError } = await import(${JSON.stringify(sourceModule)});
      try { openSourceChild(3, "inside.md"); assert.fail("opened"); }
      catch (error) {
        assert.equal(error instanceof SourceReadError, true);
        assert.equal(error.reason, "native_unavailable");
      }
      process.stdout.write("passed");
    `,
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exit = await child.exited;
  expect(exit).toBe(0);
  expect(await stdout).toBe("passed");
  expect(await stderr).toBe("");
}, 20_000);
