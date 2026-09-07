import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertPageRelPath } from "../../src/canon/paths";
import { undoReceipt } from "../../src/canon/undo";
import { targetProblem } from "../../src/contracts/page-candidate";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { runPurge } from "../../src/ledger/purge";
import { rebuildRetrieval } from "../../src/retrieval/rebuild";
import { searchResult } from "../../src/search/query";
import { doctorVault } from "../../src/vault/doctor";
import { serializePage } from "../../src/vault/frontmatter";
import { listCanonPagesReport } from "../../src/vault/pages";
import { canonFixture, putEvent, storeClaim, write } from "./helpers";

const PAGE = "facts/.kizuki/note.md";

function seed(vault: string, path: string, id: string): void {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  writeFileSync(join(vault, path), serializePage({
    data: { id, title: id, type: "fact", status: "active", sensitivity: "private", taint: "clean" },
    body: "A synthetic nested note.\n",
  }));
}

test("discovery and doctor include a nested .kizuki directory while root controls remain excluded", () => {
  const f = canonFixture();
  try {
    seed(f.vault, PAGE, "nested");
    seed(f.vault, ".kizuki/private.md", "private-control");
    seed(f.vault, "archive/history.md", "root-history");
    const report = listCanonPagesReport(f.vault);
    expect(report.pages.map(page => page.relPath)).toEqual([PAGE]);
    expect(report.skipped).toEqual([]);
    expect(doctorVault(f.vault).counts).toEqual({ total: 1, valid: 1, invalid: 0 });
  } finally { f.dispose(); }
});

test("nested control-name canon survives receipted writes, retrieval, export, restore and exact-byte undo", async () => {
  const f = canonFixture();
  const backup = `${f.vault}-backup`, restored = `${f.vault}-restored`;
  try {
    const event = putEvent(f.db);
    const created = write(f.io, await storeClaim(f.db, event, { target: "facts/.kizuki/note" }));
    expect(created.page_path).toBe(PAGE);
    const original = readFileSync(join(f.vault, PAGE));
    const edited = write(f.io, await storeClaim(f.db, event, {
      target: "facts/.kizuki/note", kind: "edit", predicate: null, object: null,
      body: "Grace leads partnerships at Acme.", frontmatter: {},
    }));
    await rebuildRetrieval(f.db, f.vault);
    expect(searchResult(f.db, "partnerships", { scope: "canon", ceiling: "private" }).hits)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: PAGE })]));
    seed(f.vault, ".kizuki/private.md", "private-control");
    seed(f.vault, "facts/.hidden/private.md", "other-hidden");
    const manifest = exportVault(f.db, f.vault, backup);
    expect(manifest.files[`vault/${PAGE}`]).toBeDefined();
    expect(manifest.files["vault/.kizuki/private.md"]).toBeUndefined();
    expect(manifest.files["vault/facts/.hidden/private.md"]).toBeUndefined();
    restoreVault(backup, restored);
    expect(readFileSync(join(restored, PAGE))).toEqual(readFileSync(join(f.vault, PAGE)));
    const restoredDb = openLedger(join(restored, ".kizuki/kizuki.db"));
    try {
      await undoReceipt({ db: restoredDb, vault_path: restored }, edited.receipt_id);
      expect(readFileSync(join(restored, PAGE))).toEqual(original);
    } finally { restoredDb.close(); }
  } finally {
    f.dispose();
    rmSync(backup, { recursive: true, force: true });
    rmSync(restored, { recursive: true, force: true });
  }
});

test("only exact nested directory spelling extends the writer and target grammar", () => {
  expect(() => assertPageRelPath(PAGE)).not.toThrow();
  expect(targetProblem("facts/.kizuki/note")).toBeNull();
  for (const path of [".kizuki/note.md", "facts/.Kizuki/note.md", "facts/.hidden/note.md", "facts/.kizuki.md", "facts/../note.md", "facts/.kizuki/../../note.md"]) {
    expect(() => assertPageRelPath(path)).toThrow();
    expect(targetProblem(path.slice(0, -3))).not.toBeNull();
  }
});

test("rebuild counts nested control-name bytes before admitting a retrieval port", async () => {
  const f = canonFixture();
  try {
    seed(f.vault, PAGE, "nested");
    truncateSync(join(f.vault, PAGE), 65 * 1024 * 1024);
    let called = false;
    const port = { rebuildFromDocuments: async () => { called = true; } } as never;
    await expect(rebuildRetrieval(f.db, f.vault, port)).rejects.toThrow("rebuild corpus exceeds");
    expect(called).toBe(false);
  } finally { f.dispose(); }
});

test("a nested control-name symlink cannot redirect discovery, writes, retrieval or export outside the vault", async () => {
  const f = canonFixture();
  const backup = `${f.vault}-backup`, outside = `${f.vault}-outside`;
  try {
    seed(outside, "secret.md", "synthetic-secret");
    const original = readFileSync(join(outside, "secret.md"));
    mkdirSync(join(f.vault, "facts"), { recursive: true });
    symlinkSync(outside, join(f.vault, "facts/.kizuki"));
    const claim = await storeClaim(f.db, putEvent(f.db), { target: "facts/.kizuki/secret" });
    expect(() => write(f.io, claim)).toThrow();
    await expect(rebuildRetrieval(f.db, f.vault)).rejects.toThrow("linked canon entries");
    expect(readFileSync(join(outside, "secret.md"))).toEqual(original);
    const report = listCanonPagesReport(f.vault);
    expect(report.pages.some(page => page.relPath === "facts/.kizuki/secret.md")).toBe(false);
    const manifest = exportVault(f.db, f.vault, backup);
    expect(manifest.files["vault/facts/.kizuki/secret.md"]).toBeUndefined();
    expect(existsSync(join(backup, "vault/facts/.kizuki"))).toBe(false);
  } finally {
    f.dispose();
    rmSync(backup, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test("erasure rewrites nested control-name canon and removes it from retrieval", async () => {
  const f = canonFixture();
  try {
    const event = putEvent(f.db);
    write(f.io, await storeClaim(f.db, event, { target: "facts/.kizuki/note" }));
    await rebuildRetrieval(f.db, f.vault);
    expect(searchResult(f.db, "partnerships", { scope: "canon", ceiling: "private" }).hits)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: PAGE })]));
    const result = await runPurge(f.db, f.vault, { event_id: event }, "retire synthetic fixture");
    expect(result.rewritten.map(receipt => receipt.page_path)).toContain(PAGE);
    expect(readFileSync(join(f.vault, PAGE), "utf8")).not.toContain("Grace runs partnerships at Acme.");
    expect(searchResult(f.db, "partnerships", { scope: "canon", ceiling: "private" }).hits).toEqual([]);
  } finally { f.dispose(); }
});
