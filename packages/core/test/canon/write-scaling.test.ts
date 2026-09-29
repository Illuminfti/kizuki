import { afterEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rebuildDerived } from "../../src/derived";
import * as ledger from "../../src/ledger/ledger";
import { readDerivedMeta } from "../../src/derived-meta";
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
  try {
    const started = performance.now();
    await recordedPage(db, vaultPath, `facts/${name}.md`, { ...PAGE, id: `fact:${name}`, title }, body);
    return { ms: performance.now() - started, evidenceReads: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
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
