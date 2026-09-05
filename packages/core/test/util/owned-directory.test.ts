import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openOwnedDirectory } from "../../src/util/owned-directory";
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "owned-dir-")); roots.push(root); const owned = join(root, "owned"), outside = join(root, "outside"); mkdirSync(join(owned, "store"), { recursive: true }); mkdirSync(join(outside, "store"), { recursive: true }); writeFileSync(join(outside, "store/canary"), "SYNTHETIC_UNOWNED"); return { root, owned, outside }; }
test("replacement of the opened root cannot redirect erasure", () => {
  const f = fixture(), cap = openOwnedDirectory(f.owned), identity = cap.childIdentity("store");
  try {
    renameSync(f.owned, join(f.root, "moved")); symlinkSync(f.outside, f.owned);
    expect(() => cap.removeTree("store", identity)).toThrow("identity");
    expect(readFileSync(join(f.outside, "store/canary"), "utf8")).toBe("SYNTHETIC_UNOWNED");
  } finally { cap.close(); }
});
test("fd-relative erasure supports non-UTF8 native names and refuses symlinks", () => {
  const f = fixture(), cap = openOwnedDirectory(f.owned);
  try {
    const bytes = Buffer.concat([Buffer.from(join(f.owned, "store") + "/"), Buffer.from([0xff])]); writeFileSync(bytes, "synthetic bytes");
    const identity = cap.childIdentity("store"); cap.removeTree("store", identity);
    expect(existsSync(join(f.owned, "store"))).toBe(false);
    mkdirSync(join(f.owned, "store")); symlinkSync(f.outside, join(f.owned, "store/link"));
    expect(() => cap.removeTree("store", cap.childIdentity("store"))).toThrow("unsafe");
    expect(readFileSync(join(f.outside, "store/canary"), "utf8")).toBe("SYNTHETIC_UNOWNED");
  } finally { cap.close(); }
});
test("depth bounds and replaced store identity refuse completion", () => {
  const f = fixture(), cap = openOwnedDirectory(f.owned);
  try {
    const original = cap.childIdentity("store");
    renameSync(join(f.owned, "store"), join(f.owned, "prior")); mkdirSync(join(f.owned, "store"));
    expect(() => cap.removeTree("store", original)).toThrow("identity");
    let path = join(f.owned, "store");
    for (let i = 0; i < 66; i++) { path = join(path, "d"); mkdirSync(path); }
    writeFileSync(join(path, "canary"), "KEEP_DEPTH_BOUND");
    expect(() => cap.removeTree("store", cap.childIdentity("store"))).toThrow("bounds");
    expect(readFileSync(join(path, "canary"), "utf8")).toBe("KEEP_DEPTH_BOUND");
  } finally { cap.close(); }
});

test("maintenance lock shares ordinary ownership and never creates a missing lock", async () => {
  const { tryAdvisoryFileLock } = await import("../../src/util/advisory-file-lock");
  const f = fixture(), cap = openOwnedDirectory(f.owned);
  try {
    expect(() => cap.tryLock(["writer.lock"])).toThrow("lock_missing");
    expect(existsSync(join(f.owned, "writer.lock"))).toBe(false);
    const ordinary = tryAdvisoryFileLock(join(f.owned, "writer.lock"))!;
    expect(cap.tryLock(["writer.lock"])).toBeNull(); ordinary.release();
    const maintenance = cap.tryLock(["writer.lock"])!;
    expect(tryAdvisoryFileLock(join(f.owned, "writer.lock"))).toBeNull();
    maintenance.release(); maintenance.release();
    const reopened = tryAdvisoryFileLock(join(f.owned, "writer.lock")); expect(reopened).not.toBeNull(); reopened?.release();
  } finally { cap.close(); }
});

test("root replacement after maintenance precheck cannot create or lock outside files", () => {
  const f = fixture(), cap = openOwnedDirectory(f.owned);
  writeFileSync(join(f.owned, "writer.lock"), "");
  const original = cap.assertCurrent.bind(cap); let swapped = false;
  cap.assertCurrent = () => {
    original();
    if (!swapped) { swapped = true; renameSync(f.owned, join(f.root, "moved")); symlinkSync(f.outside, f.owned); }
  };
  try {
    expect(() => cap.tryLock(["writer.lock"])).toThrow();
    expect(swapped).toBe(true);
    expect(existsSync(join(f.outside, "writer.lock"))).toBe(false);
    expect(readFileSync(join(f.outside, "store/canary"), "utf8")).toBe("SYNTHETIC_UNOWNED");
  } finally { cap.close(); }
});

test("emptiness starts a fresh directory scan on every call and sees new native entries", () => {
  const f = fixture(), cap = openOwnedDirectory(f.owned);
  try {
    expect(cap.isEmpty()).toBe(false);
    expect(cap.isEmpty()).toBe(false);
    rmSync(join(f.owned, "store"), { recursive: true });
    expect(cap.isEmpty()).toBe(true);
    const raw = Buffer.concat([Buffer.from(f.owned + "/"), Buffer.from([0xff])]);
    writeFileSync(raw, "SYNTHETIC_KEEP");
    expect(cap.isEmpty()).toBe(false);
    expect(cap.isEmpty()).toBe(false);
    rmSync(raw);
    symlinkSync(f.outside, join(f.owned, "unknown"));
    expect(cap.isEmpty()).toBe(false);
    expect(readFileSync(join(f.outside, "store/canary"), "utf8")).toBe("SYNTHETIC_UNOWNED");
  } finally { cap.close(); }
  expect(() => cap.isEmpty()).toThrow("closed");
});

test("emptiness refuses a root replaced during its observation", () => {
  const f = fixture(); rmSync(join(f.owned, "store"), { recursive: true });
  const cap = openOwnedDirectory(f.owned), original = cap.assertCurrent.bind(cap);
  let swap = true;
  cap.assertCurrent = () => {
    original();
    if (swap) { swap = false; renameSync(f.owned, join(f.root, "moved")); symlinkSync(f.outside, f.owned); }
  };
  try { expect(() => cap.isEmpty()).toThrow("identity"); }
  finally { cap.close(); }
});

for (const operation of ["empty-scan", "erase"] as const) test(`${operation} survives errno changes during memory-view allocation`, () => {
  const f = fixture(), cap = openOwnedDirectory(f.owned);
  if (operation === "empty-scan") rmSync(join(f.owned, "store"), { recursive: true });
  const libc = dlopen("libc.so.6", { __errno_location: { args: [], returns: FFIType.ptr } });
  const pointer = libc.symbols.__errno_location();
  if (!pointer) throw new Error("synthetic errno fixture unavailable");
  const OriginalDataView = DataView;
  const error = new OriginalDataView(toArrayBuffer(pointer, 0, 4));
  const store = cap.childIdentity("store");
  let allocations = 0;
  // A pinned-Bun EOF probe observed errno 0 become EAGAIN while the old
  // helper allocated its view. Reproduce that VM boundary deterministically.
  globalThis.DataView = new Proxy(OriginalDataView, {
    construct(target, args, newTarget) {
      const view = Reflect.construct(target, args, newTarget);
      allocations++;
      error.setInt32(0, 11 /* EAGAIN */, true);
      return view;
    },
  });
  try {
    if (operation === "empty-scan") expect(cap.isEmpty()).toBe(true);
    else { cap.removeTree("store", store); expect(existsSync(join(f.owned, "store"))).toBe(false); }
    expect(allocations).toBeGreaterThan(0);
    expect(readFileSync(join(f.outside, "store/canary"), "utf8")).toBe("SYNTHETIC_UNOWNED");
  } finally { globalThis.DataView = OriginalDataView; cap.close(); libc.close(); }
});

test("many-child erasure and repeated empty scans retain native EOF semantics", () => {
  const f = fixture(), cap = openOwnedDirectory(f.owned);
  try {
    for (let directory = 0; directory < 32; directory++) {
      const path = join(f.owned, "store", `directory-${directory}`);
      mkdirSync(path);
      for (let file = 0; file < 32; file++) writeFileSync(join(path, `file-${file}`), "SYNTHETIC_OWNED");
    }
    cap.removeTree("store", cap.childIdentity("store"));
    expect(existsSync(join(f.owned, "store"))).toBe(false);
    for (let scan = 0; scan < 256; scan++) expect(cap.isEmpty()).toBe(true);
    expect(readFileSync(join(f.outside, "store/canary"), "utf8")).toBe("SYNTHETIC_UNOWNED");
  } finally { cap.close(); }
});
