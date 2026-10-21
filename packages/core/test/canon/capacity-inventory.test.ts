import { afterEach, expect, spyOn, test } from "bun:test";
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireCanonWriteCapacity } from "../../src/canon/capacity";
import { currentCapacityBound } from "../../src/vault/capacity-inventory";
import { parseFrontmatter, serializePage } from "../../src/vault/frontmatter";
import * as pages from "../../src/vault/pages";
import { tempVault } from "../helpers/vault";

const dispose: (() => void)[] = [];
afterEach(() => { for (const close of dispose.splice(0)) close(); });
function fixture(count = 1, status: "active" | "archived" = "active") {
  const vault = tempVault(); dispose.push(vault.dispose);
  for (let i = 0; i < count; i++) {
    writeFileSync(join(vault.path, `facts/page-${i}.md`), serializePage({
      data: { id: `fact:${i}`, title: `Page ${i}`, type: "fact", status, sensitivity: "personal", taint: "clean", sources: [] },
      body: "Synthetic capacity fixture.",
    }), { mode: 0o600 });
  }
  return vault.path;
}
function seed(vault: string) {
  const report = pages.listCanonPagesReport(vault);
  expect(report.truncated).toBe(false);
  const bound = currentCapacityBound(vault);
  expect(bound).not.toBeNull();
  return bound!;
}

test("the bound accounts for synchronous edits, atomic replacement, removal and hardlink edits", () => {
  const vault = fixture(), file = join(vault, "facts/page-0.md");
  const initial = seed(vault);
  writeFileSync(file, Buffer.alloc(2000, 65));
  expect(currentCapacityBound(vault)).toEqual({ files: 1, bytes: 2000 });
  const replacement = join(vault, "facts/replacement.tmp");
  writeFileSync(replacement, Buffer.alloc(3000, 66)); renameSync(replacement, file);
  expect(currentCapacityBound(vault)).toEqual({ files: 1, bytes: 3000 });
  const alias = join(vault, ".kizuki/external-alias");
  linkSync(file, alias); writeFileSync(alias, Buffer.alloc(4000, 67));
  expect(currentCapacityBound(vault)).toEqual({ files: 1, bytes: 4000 });
  rmSync(file);
  expect(currentCapacityBound(vault)).toEqual({ files: 0, bytes: 0 });
  expect(initial.bytes).toBeGreaterThan(0);
});

test("new candidates and lowered limits are checked before permitting growth", () => {
  const vault = fixture(); seed(vault);
  writeFileSync(join(vault, ".kizuki/serve.toml"), "[canon]\nmax_scan_bytes=65536\n");
  writeFileSync(join(vault, "facts/new.md"), Buffer.alloc(64_536, 120));
  expect(currentCapacityBound(vault)?.files).toBe(2);
  expect(() => requireCanonWriteCapacity(vault, true, 1, 2000)).toThrow(expect.objectContaining({ code: "canon_scan_incomplete" }));
});

test("archives are conservative slots only until exact classification is necessary", () => {
  const vault = fixture(100, "archived");
  writeFileSync(join(vault, ".kizuki/serve.toml"), "[canon]\nmax_live_pages=100\n");
  expect(seed(vault).files).toBe(100);
  const walk = spyOn(pages, "listCanonPagesReport");
  try {
    expect(() => requireCanonWriteCapacity(vault, true, 1, 100)).not.toThrow();
    expect(walk).toHaveBeenCalledTimes(1);
  } finally { walk.mockRestore(); }
});

test("memory-mapped archive reactivation cannot borrow cached free live slots", () => {
  const vault = fixture(100, "archived");
  writeFileSync(join(vault, ".kizuki/serve.toml"), "[canon]\nmax_live_pages=100\n");
  const native = dlopen("libc.so.6", {
    mmap: { args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.ptr },
    munmap: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  const mappings: { fd: number; address: ReturnType<typeof native.symbols.mmap>; length: number; offset: number }[] = [];
  try {
    // Open before the scan and keep the handles open: no close-write event can
    // accidentally make this test pass by notifying the inventory.
    for (let i = 0; i < 100; i++) {
      const path = join(vault, `facts/page-${i}.md`), bytes = readFileSync(path), fd = openSync(path, "r+");
      const address = native.symbols.mmap(null, bytes.length, 3, 1, fd, 0);
      if (address === null || Number(address) === -1) throw new Error("fixture mmap failed");
      mappings.push({ fd, address, length: bytes.length, offset: bytes.indexOf('"archived"') });
    }
    const initial = seed(vault);
    for (const mapped of mappings) new Uint8Array(toArrayBuffer(mapped.address!, 0, mapped.length)).set(Buffer.from('"active"  '), mapped.offset);
    expect(parseFrontmatter(readFileSync(join(vault, "facts/page-0.md"), "utf8")).data.status).toBe("active");
    // The resource bound is unchanged even when notifications are silent.
    expect(currentCapacityBound(vault)).toEqual(initial);
    expect(() => requireCanonWriteCapacity(vault, true, 1, 100)).toThrow(expect.objectContaining({ code: "canon_ceiling" }));
  } finally {
    for (const mapped of mappings) { native.symbols.munmap(mapped.address!, mapped.length); closeSync(mapped.fd); }
    native.close();
  }
});

test("directory replacement, a symlink candidate and notification overflow discard fast authority", () => {
  const vault = fixture(); seed(vault);
  renameSync(join(vault, "facts"), join(vault, "old-facts")); mkdirSync(join(vault, "facts"));
  expect(currentCapacityBound(vault)).toBeNull();
  seed(vault);
  symlinkSync(join(vault, "old-facts/page-0.md"), join(vault, "facts/link.md"));
  expect(currentCapacityBound(vault)).toBeNull();
  rmSync(join(vault, "facts/link.md")); seed(vault);
  // Real kernel loss, not a mocked event parser. Names alternate so adjacent
  // identical notifications cannot coalesce away the backlog.
  for (let i = 0; i < 12_000; i++) writeFileSync(join(vault, `facts/noise-${i % 2}.tmp`), "x");
  expect(currentCapacityBound(vault)).toBeNull();
});

test("a scoped read cannot replace the complete inventory and root replacement invalidates it", () => {
  const vault = fixture(2); seed(vault);
  pages.listCanonPagesReport(vault, undefined, new Set(["facts/page-1.md"]));
  expect(currentCapacityBound(vault)?.files).toBe(2);
  const old = `${vault}-replaced`;
  renameSync(vault, old); mkdirSync(vault);
  dispose.push(() => rmSync(old, { recursive: true, force: true }));
  expect(currentCapacityBound(vault)).toBeNull();
});

test("deleted file watches are rearmed and non-UTF8 candidate names discard the bound", () => {
  const vault = fixture(), path = join(vault, "facts/page-0.md"); seed(vault);
  rmSync(path); writeFileSync(path, "replacement");
  expect(currentCapacityBound(vault)).toEqual({ files: 1, bytes: 11 });
  writeFileSync(path, "replacement grew");
  expect(currentCapacityBound(vault)).toEqual({ files: 1, bytes: 16 });
  const invalidName = Buffer.concat([Buffer.from(`${vault}/facts/`), Buffer.from([0xff]), Buffer.from(".md")]);
  writeFileSync(invalidName, "unexpected candidate");
  expect(currentCapacityBound(vault)).toBeNull();
});

test("the process cache evicts old vaults without changing exact fallback behavior", () => {
  const first = fixture(); seed(first);
  for (let i = 0; i < 4; i++) seed(fixture());
  expect(currentCapacityBound(first)).toBeNull();
  expect(() => requireCanonWriteCapacity(first, true, 1, 100)).not.toThrow();
  expect(currentCapacityBound(first)).not.toBeNull();
});
