import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCapacityInventories, currentCapacityBound } from "../../src/vault/capacity-inventory";
import { serializePage } from "../../src/vault/frontmatter";
import { createCanonPageCache, listCanonPagesReport } from "../../src/vault/pages";

let vault: string | null = null;
afterEach(() => {
  if (vault !== null) rmSync(vault, { recursive: true, force: true });
  vault = null;
});

const LONG_AGO = new Date("2026-01-01T00:00:00Z");

function scratch(): string {
  vault = mkdtempSync(join(tmpdir(), "kizuki-page-cache-"));
  mkdirSync(join(vault, "facts"));
  return vault;
}

/** Writes a page and backdates it, as a file that has been on disk a while. */
function put(root: string, name: string, id: string, body: string, settled = true): string {
  const path = join(root, "facts", `${name}.md`);
  writeFileSync(
    path,
    serializePage({
      data: { id, title: id, type: "fact", status: "active", sensitivity: "public", taint: "clean" },
      body,
    }),
    "utf8",
  );
  if (settled) utimesSync(path, LONG_AGO, LONG_AGO);
  return path;
}

test("a walk with a cache returns what a walk without one returns", () => {
  const root = scratch();
  put(root, "a", "fact:a", "alpha");
  put(root, "b", "fact:b", "beta");
  writeFileSync(join(root, "facts", "broken.md"), "---\nid: [unterminated\n---\nx", "utf8");
  const cache = createCanonPageCache();
  const plain = listCanonPagesReport(root);
  expect(listCanonPagesReport(root, cache)).toEqual(plain);
  expect(listCanonPagesReport(root, cache)).toEqual(plain);
});

test("an unchanged file that has settled is not read again", async () => {
  const root = scratch();
  const path = put(root, "a", "fact:a", "alpha");
  // The status change time cannot be backdated; wait out the settle window.
  await Bun.sleep(2_100);
  const cache = createCanonPageCache();
  listCanonPagesReport(root, cache);
  const first = cache.files.get(path);
  expect(first).toBeDefined();
  listCanonPagesReport(root, cache);
  expect(cache.files.get(path)).toBe(first);
});

test("an edit that keeps the size and the modification time is still seen", () => {
  const root = scratch();
  const path = put(root, "a", "fact:a", "alpha");
  const cache = createCanonPageCache();
  expect(listCanonPagesReport(root, cache).pages[0]?.body.trim()).toBe("alpha");
  put(root, "a", "fact:a", "omega");
  utimesSync(path, LONG_AGO, LONG_AGO);
  expect(listCanonPagesReport(root, cache).pages[0]?.body.trim()).toBe("omega");
});

test("a file edited moments after it was read is never trusted from the cache", () => {
  const root = scratch();
  const path = put(root, "a", "fact:a", "alpha", false);
  const cache = createCanonPageCache();
  listCanonPagesReport(root, cache);
  expect(cache.files.has(path)).toBe(false);
  put(root, "a", "fact:a", "omega", false);
  expect(listCanonPagesReport(root, cache).pages[0]?.body.trim()).toBe("omega");
});

test("added and removed files appear and disappear on the next walk", () => {
  const root = scratch();
  const first = put(root, "a", "fact:a", "alpha");
  const cache = createCanonPageCache();
  expect(listCanonPagesReport(root, cache).pages.map((page) => page.id)).toEqual(["fact:a"]);
  put(root, "b", "fact:b", "beta");
  expect(listCanonPagesReport(root, cache).pages.map((page) => page.id)).toEqual(["fact:a", "fact:b"]);
  unlinkSync(first);
  expect(listCanonPagesReport(root, cache).pages.map((page) => page.id)).toEqual(["fact:b"]);
  expect(cache.files.has(first)).toBe(false);
});

test("a caller cannot change what the next walk is given", () => {
  const root = scratch();
  put(root, "a", "fact:a", "alpha");
  const cache = createCanonPageCache();
  const page = listCanonPagesReport(root, cache).pages[0]!;
  page.data["title"] = "tampered";
  expect(listCanonPagesReport(root, cache).pages[0]?.data["title"]).toBe("fact:a");
});

test("a duplicate identity is withheld from every walk, cached or not", () => {
  const root = scratch();
  put(root, "a", "fact:same", "alpha");
  put(root, "b", "fact:same", "beta");
  const cache = createCanonPageCache();
  for (let walk = 0; walk < 2; walk += 1) {
    const report = listCanonPagesReport(root, cache);
    expect(report.pages).toEqual([]);
    expect(report.skipped.map((entry) => entry.code)).toEqual(["duplicate", "duplicate"]);
  }
});

test("include_body: false and track_capacity: false preserve hashes, frontmatter, and skips without retaining bodies or watches", () => {
  const root = scratch();
  put(root, "lf", "fact:lf", "Multi-byte body \u2603 ".repeat(200));
  writeFileSync(
    join(root, "facts", "crlf.md"),
    '---\r\nid: "fact:crlf"\r\ntitle: "CRLF"\r\ntype: "fact"\r\nstatus: "active"\r\nsensitivity: "public"\r\ntaint: "clean"\r\n---\r\nBody after CRLF\r\n',
    "utf8",
  );
  writeFileSync(
    join(root, "facts", "eof.md"),
    '---\nid: "fact:eof"\ntitle: "EOF"\ntype: "fact"\nstatus: "archived"\nsensitivity: "public"\ntaint: "clean"\n---',
    "utf8",
  );
  writeFileSync(join(root, "facts", "broken.md"), "---\nid: [unterminated\n---\nbody", "utf8");
  writeFileSync(join(root, "facts", "no-close.md"), "---\nid: \"x\"\nno closing fence", "utf8");

  closeCapacityInventories();
  const lite = listCanonPagesReport(root, undefined, undefined, {
    include_body: false,
    track_capacity: false,
  });
  expect(currentCapacityBound(root)).toBeNull();

  const full = listCanonPagesReport(root);
  expect(lite.truncated).toBe(full.truncated);
  expect(lite.scanned_files).toBe(full.scanned_files);
  expect(lite.scanned_bytes).toBe(full.scanned_bytes);
  expect(lite.skipped).toEqual(full.skipped);
  expect(lite.pages.map(({ body: _b, ...rest }) => rest)).toEqual(
    full.pages.map(({ body: _b, ...rest }) => rest),
  );
  expect(lite.pages.every((page) => page.body === "")).toBe(true);

  // Passing a cache with include_body: false must not poison subsequent full walks.
  const cache = createCanonPageCache();
  listCanonPagesReport(root, cache, undefined, { include_body: false, track_capacity: false });
  expect(cache.files.size).toBe(0);
  const fullAfter = listCanonPagesReport(root, cache);
  expect(fullAfter.pages.find((p) => p.id === "fact:lf")?.body).toContain("\u2603");
});
