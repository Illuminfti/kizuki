import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openOwnedDirectory } from "../../src/util/owned-directory";
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
