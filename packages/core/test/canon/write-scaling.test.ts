import { afterEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rebuildDerived } from "../../src/derived";
import * as ledger from "../../src/ledger/ledger";
import * as pages from "../../src/vault/pages";
import * as provenance from "../../src/vault/provenance";
import { readDerivedMeta } from "../../src/derived-meta";
import { clearGraphRegistry } from "../../src/graph/graph";
import { tryWriteFlock } from "../../src/serve/flock";
import { seedLivePages } from "../helpers/bulk-pages";
import { recordedPage } from "../helpers/recorded-page";
import { searchDb, tempVault } from "../search/helpers";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

const PAGE = { type: "fact", status: "active", sensitivity: "personal", taint: "clean" } as const;

function edges(db: Database): unknown[] {
  return db.query("SELECT * FROM graph_edges ORDER BY src, dst, kind").all();
}

/** A vault of `count` live pages, each linking to the next, whose graph a rebuild has filled. */
function vaultOf(count: number) {
  const db = searchDb();
  const vault = tempVault();
  disposers.push(() => db.close(), vault.dispose);
  seedLivePages(db, vault.path, count, { body: (index) => `Bulk page ${index}. See [[Bulk ${index + 1}]].` });
  rebuildDerived(db, vault.path);
  return { db, vault };
}

async function timedWrite(db: Database, vaultPath: string, name: string, body: string, title = name) {
  const spy = spyOn(ledger, "readLiveEvent");
  const assess = spyOn(provenance, "assessLivePageEvidence");
  try {
    const started = performance.now();
    const written = await recordedPage(db, vaultPath, `facts/${name}.md`, { ...PAGE, id: `fact:${name}`, title }, body);
    const ms = performance.now() - started;
    expect(assess.mock.calls.length).toBeGreaterThan(0);
    expect(assess.mock.calls.every(([, page]) => page.relPath === written.receipt.page_path)).toBe(true);
    expect(spy.mock.calls.every(([, id]) => written.sourceIds.includes(id))).toBe(true);
    return { ms, evidenceReads: spy.mock.calls.length };
  } finally {
    spy.mockRestore(); assess.mockRestore();
  }
}

async function bestWrite(db: Database, vaultPath: string, prefix: string) {
  const runs = [];
  for (let index = 0; index < 3; index += 1) runs.push(await timedWrite(db, vaultPath, `${prefix}-${index}`, "New page."));
  runs.sort((left, right) => left.ms - right.ms);
  // The fastest of three: a busy host slows a run, never speeds one up.
  return { ms: runs[0]!.ms, evidenceReads: Math.max(...runs.map((run) => run.evidenceReads)) };
}

test("one canon write assesses only the written page's evidence and costs the same at 4,000 pages as at 200", async () => {
  const small = vaultOf(200);
  const large = vaultOf(4_000);
  // Warm the write path once so the first timed write does not pay for loading it.
  await timedWrite(small.db, small.vault.path, "warm-small", "Warm.");
  await timedWrite(large.db, large.vault.path, "warm-large", "Warm.");
  const few = await bestWrite(small.db, small.vault.path, "small");
  const many = await bestWrite(large.db, large.vault.path, "large");
  // A page names one source; the search and graph projections each assess it once.
  expect(few.evidenceReads).toBeLessThanOrEqual(4);
  expect(many.evidenceReads).toBe(few.evidenceReads);
  expect(many.ms).toBeLessThan(few.ms * 3);
}, 240_000);

test("an incremental write leaves the graph a full rebuild would produce", async () => {
  const { db, vault } = vaultOf(60);
  // A repeated title makes links to it ambiguous; a new title resolves one that was raw.
  await timedWrite(db, vault.path, "seven-again", "Second holder of a title. See [[Bulk 9]] and [[Missing]].", "Bulk 7");
  await timedWrite(db, vault.path, "missing", "Now resolvable.", "Missing");
  const incremental = edges(db);
  expect(incremental.length).toBeGreaterThan(120);
  expect(readDerivedMeta(db, "graph")?.status).toBe("ok");
  rebuildDerived(db, vault.path);
  expect(edges(db)).toEqual(incremental);
}, 120_000);

test("the receipted writer does no vault walk and assesses only its page", async () => {
  const { db, vault } = vaultOf(200);
  const scan = spyOn(pages, "scanCanonSignatures");
  const walk = spyOn(pages, "listCanonPagesReport");
  const assess = spyOn(provenance, "assessLivePageEvidence");
  try {
    await recordedPage(db, vault.path, "facts/one-page.md", { ...PAGE, id: "fact:one-page", title: "One page" }, "See [[Bulk 9]].");
    expect(scan).not.toHaveBeenCalled();
    expect(walk).not.toHaveBeenCalled();
    expect(assess.mock.calls.length).toBeGreaterThan(0);
    expect(assess.mock.calls.every(([, page]) => page.relPath === "facts/one-page.md")).toBe(true);
  } finally {
    scan.mockRestore(); walk.mockRestore(); assess.mockRestore();
  }
});

test("the first write after registry loss reconciles outside writer ownership", async () => {
  const { db, vault } = vaultOf(4_000);
  clearGraphRegistry(db);
  const original = provenance.assessLivePageEvidence;
  let outside = 0, inside = 0;
  const assess = spyOn(provenance, "assessLivePageEvidence").mockImplementation((...args) => {
    if (args[1].relPath !== "facts/first.md") {
      if (outside === 0) {
        const lock = tryWriteFlock(vault.path);
        expect(lock).not.toBeNull(); lock?.release();
      }
      outside++;
    } else {
      const lock = tryWriteFlock(vault.path);
      if (lock === null) inside++;
      else lock.release();
    }
    return original(...args);
  });
  try {
    await recordedPage(db, vault.path, "facts/first.md", { ...PAGE, id: "fact:first", title: "First" }, "First write.");
    expect(outside).toBeGreaterThanOrEqual(4_000);
    expect(inside).toBeGreaterThan(0);
    const incremental = edges(db);
    rebuildDerived(db, vault.path);
    expect(edges(db)).toEqual(incremental);
  } finally { assess.mockRestore(); }
}, 120_000);
