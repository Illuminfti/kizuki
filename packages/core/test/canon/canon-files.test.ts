import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonFilesError, openCanonFiles, type CanonFileSnapshot } from "../../src/vault/canon-files";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "canon-files-")); roots.push(root); return root; }
function qualifiedAncestry(path: string): boolean {
  if (process.platform !== "linux" || process.arch !== "x64" || process.geteuid === undefined) return false;
  const uid = BigInt(process.geteuid());
  let current = "/";
  for (const component of path.split("/").filter(Boolean)) {
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || (stat.uid !== 0n && stat.uid !== uid)) return false;
    if ((stat.mode & 0o022n) !== 0n && !(stat.uid === 0n && (stat.mode & 0o1000n) !== 0n)) return false;
    current = join(current, component);
  }
  const last = lstatSync(current, { bigint: true });
  return last.isDirectory() && (last.uid === 0n || last.uid === uid) &&
    ((last.mode & 0o022n) === 0n || (last.uid === 0n && (last.mode & 0o1000n) !== 0n));
}
const canExercise = qualifiedAncestry(tmpdir());
const qualified = test.if(canExercise);

test("validates native fixture custody and refuses unsupported environments", () => {
  if (canExercise) openCanonFiles(fixture()).close();
  else expect(() => openCanonFiles(fixture())).toThrow(CanonFilesError);
  if (process.env.GITHUB_ACTIONS === "true" && process.platform === "linux" && process.arch === "x64") expect(canExercise).toBe(true);
});

qualified("creates bounded nested files and returns immutable expected-byte snapshots", () => {
  const root = fixture(), files = openCanonFiles(root);
  try {
    files.ensureDirectory("facts/archive"); files.ensureDirectory("facts/archive");
    expect(lstatSync(join(root, "facts")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(root, "facts/archive")).mode & 0o777).toBe(0o700);
    expect(files.read("missing/page.md")).toBeNull();
    for (const path of ["facts/CANON.md", "facts/SCHEMA.md", "facts/archive/page.md"]) {
      const input = Uint8Array.from([97, 98, 99]), made = files.create(path, input);
      input[0] = 0;
      const copy = made.bytes; copy[1] = 0;
      expect(made.path).toBe(path);
      expect(made.bytes).toEqual(Uint8Array.from([97, 98, 99]));
      expect(lstatSync(join(root, path)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, path), "utf8")).toBe("abc");
      const read = files.read(path)!;
      expect(read.bytes).toEqual(made.bytes); read.close(); made.close();
    }
    const empty = files.create("empty.md", new Uint8Array());
    expect(empty.bytes.byteLength).toBe(0); empty.close();
    // Neither the scope nor its public handles expose descriptors or native flags.
    expect(Reflect.ownKeys(files)).toEqual([]);
    expect(Reflect.ownKeys(empty).sort()).toEqual(["bytes", "close", "path"]);
  } finally { files.close(); }
});

qualified("archives the captured preimage and publishes a complete replacement", () => {
  const root = fixture(), files = openCanonFiles(root);
  try {
    files.ensureDirectory("pages"); files.ensureDirectory("archive");
    const prior = files.create("pages/item.md", Buffer.from("prior synthetic content"));
    const archive = files.create("archive/item.before.md", prior.bytes); archive.close();
    const temporary = files.create("pages/item.tmp", Buffer.from("new synthetic content"));
    const published = files.replace(temporary, prior);
    expect(Buffer.from(published.bytes).toString()).toBe("new synthetic content");
    expect(readFileSync(join(root, "archive/item.before.md"), "utf8")).toBe("prior synthetic content");
    expect(files.read("pages/item.tmp")).toBeNull();
    expect(() => prior.bytes).toThrow("canon_files_handle");
    expect(() => temporary.bytes).toThrow("canon_files_handle");
    files.remove(published);
    expect(files.read("pages/item.md")).toBeNull();
    expect(() => files.remove(published)).toThrow("canon_files_handle");
  } finally { files.close(); }
});

qualified("exclusive creation preserves existing bytes and requires an owned creation for replacement", () => {
  const root = fixture(), files = openCanonFiles(root);
  try {
    const a = files.create("a.md", Buffer.from("first")), b = files.create("b.md", Buffer.from("second"));
    expect(() => files.create("a.md", Buffer.from("overwrite"))).toThrow("canon_files_conflict");
    const read = files.read("b.md")!;
    expect(() => files.replace(read, a)).toThrow("canon_files_handle");
    expect(() => files.replace(a, a)).toThrow("canon_files_handle");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("first");
    read.close(); a.close(); b.close();
  } finally { files.close(); }
});

qualified("rejects foreign, forged and closed handles with private typed errors", () => {
  const first = openCanonFiles(fixture()), second = openCanonFiles(fixture());
  try {
    const page = first.create("page.md", Buffer.from("synthetic"));
    expect(() => second.remove(page)).toThrow("canon_files_handle");
    expect(() => first.remove({ path: "page.md", bytes: page.bytes, close() {} } as CanonFileSnapshot)).toThrow("canon_files_handle");
    page.close(); page.close();
    expect(() => page.bytes).toThrow("canon_files_handle");
    const held = first.read("page.md")!;
    first.close(); first.close(); held.close();
    expect(() => held.bytes).toThrow("canon_files_closed");
    expect(() => first.read("page.md")).toThrow("canon_files_closed");
  } finally { first.close(); second.close(); }
});

qualified("refuses invalid paths and byte bounds before creating entries", () => {
  const root = fixture(), files = openCanonFiles(root);
  try {
    for (const path of ["", "/a", ".", "..", "a/../b", "a//b", "a\\b", "a\0b", "x".repeat(256), "\ud800"]) {
      expect(() => files.create(path, Buffer.from("synthetic"))).toThrow("canon_files_invalid_path");
    }
    expect(() => files.ensureDirectory(Array(65).fill("d").join("/"))).toThrow("canon_files_bounds");
    expect(() => files.create("large.md", new Uint8Array(1_048_577))).toThrow("canon_files_bounds");
    expect(readdirSync(root)).toEqual([]);
  } finally { files.close(); }
});

qualified("refuses stationary unsupported entries and unsafe file metadata", () => {
  const root = fixture(), files = openCanonFiles(root);
  try {
    mkdirSync(join(root, "directory.md"));
    expect(() => files.read("directory.md")).toThrow("canon_files_unsafe");
    writeFileSync(join(root, "shared.md"), "synthetic");
    linkSync(join(root, "shared.md"), join(root, "second.md"));
    expect(() => files.read("shared.md")).toThrow("canon_files_unsafe");
    writeFileSync(join(root, "writable.md"), "synthetic"); chmodSync(join(root, "writable.md"), 0o666);
    expect(() => files.read("writable.md")).toThrow("canon_files_unsafe");
    expect(readFileSync(join(root, "second.md"), "utf8")).toBe("synthetic");
  } finally { files.close(); }
});

qualified("an ordinary owner edit invalidates a retained snapshot", () => {
  const root = fixture(), files = openCanonFiles(root);
  try {
    const page = files.create("page.md", Buffer.from("first"));
    writeFileSync(join(root, "page.md"), "owner correction");
    expect(() => files.remove(page)).toThrow("canon_files_changed");
    expect(readFileSync(join(root, "page.md"), "utf8")).toBe("owner correction");
  } finally { files.close(); }
});

qualified("repeated close releases all retained file and directory descriptors", () => {
  const root = fixture(); openCanonFiles(root).close();
  const before = readdirSync("/proc/self/fd").length;
  for (let i = 0; i < 32; i++) {
    const files = openCanonFiles(root), made = files.create(`page-${i}.md`, Buffer.from("synthetic"));
    files.read(made.path); files.read(made.path); files.close(); files.close();
  }
  expect(readdirSync("/proc/self/fd").length).toBe(before);
});

for (const mode of ["unsupported", "unavailable", "unknown-native", "partial-write", "no-progress"] as const) {
  qualified(`normalizes ${mode} and closes operation resources`, () => {
    const root = fixture();
    const script = `
      import { mock } from "bun:test";
      import * as fs from "node:fs";
      import { strict as assert } from "node:assert";
      const mode = ${JSON.stringify(mode)}, root = ${JSON.stringify(root)};
      const realWrite = fs.writeSync;
      let written = 0;
      if (mode === 'unsupported') Object.defineProperty(process, 'platform', {value: 'darwin'});
      if (mode === 'unavailable' || mode === 'unknown-native') {
        mock.module(${JSON.stringify(join(import.meta.dir, "../../src/util/owned-directory-native.ts"))}, () => ({
          loadOwnedDirectoryNative() {
            if (mode === 'unavailable') throw new Error('synthetic private detail');
            return { symbols: { openChild() { return -1234; } } };
          }
        }));
      }
      if (mode === 'partial-write' || mode === 'no-progress') mock.module('node:fs', () => ({ ...fs, writeSync(fd, bytes, offset, length, position) {
        if (mode === 'no-progress') return 0;
        const count = realWrite(fd, bytes, offset, Math.min(length, 2), position); written += count; return count;
      } }));
      const {openCanonFiles, CanonFilesError} = await import(${JSON.stringify(join(import.meta.dir, "../../src/vault/canon-files.ts"))});
      // Bun's first native compilation retains its process-wide /tmp handle.
      // Initialize the loader alone before measuring operation-owned lifetimes.
      if (mode === 'partial-write' || mode === 'no-progress') {
        const {loadOwnedDirectoryNative} = await import(${JSON.stringify(join(import.meta.dir, "../../src/util/owned-directory-native.ts"))});
        const native = loadOwnedDirectoryNative(); native.compiled.close(); native.libc.close();
      }
      const before = fs.readdirSync('/proc/self/fd').length;
      if (['unsupported', 'unavailable', 'unknown-native'].includes(mode)) {
        const reason = {unsupported: 'unsupported', unavailable: 'native_unavailable', 'unknown-native': 'unsafe'}[mode];
        assert.throws(() => openCanonFiles(root), error => error instanceof CanonFilesError && error.reason === reason && error.message === 'canon_files_' + reason);
      } else {
        const cap = openCanonFiles(root);
        try {
          if (mode === 'no-progress') {
            assert.throws(() => cap.create('page.md', Buffer.from('synthetic')), {message: 'canon_files_io'});
            assert.equal(fs.existsSync(root + '/page.md'), false);
          } else {
            const file = cap.create('page.md', Buffer.from('synthetic'));
            assert.equal(Buffer.from(file.bytes).toString(), 'synthetic'); assert.equal(written, 9); file.close();
          }
        } finally { cap.close(); }
      }
      assert.equal(fs.readdirSync('/proc/self/fd').length, before);
      process.stdout.write('passed');
    `;
    const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(child.error).toBeUndefined(); expect(child.stderr).toBe("");
    expect(child.status).toBe(0); expect(child.stdout).toBe("passed");
    if (mode !== "partial-write") expect(existsSync(join(root, "page.md"))).toBe(false);
  });
}
