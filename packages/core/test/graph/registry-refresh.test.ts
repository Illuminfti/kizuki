import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as graph from "../../src/graph/graph";
import { initGraph } from "../../src/graph/schema";
import { rebuildDerived, refreshDerivedPage, removeDerivedPage } from "../../src/derived";
import { readDerivedMeta } from "../../src/derived-meta";
import { serializePage } from "../../src/vault/frontmatter";
import { listCanonPages } from "../../src/vault/pages";
import { recordedPage } from "../helpers/recorded-page";
import { searchDb, tempVault } from "../search/helpers";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

const TITLES = ["Alpha", "alpha", "Beta", "Gamma", "Émile", "émile"];

function graphRows(db: Database): unknown[] {
  return db.query("SELECT * FROM graph_edges ORDER BY src, dst, kind").all();
}

/** What a full rebuild of a copy of this ledger over the same vault projects. */
function rebuiltRows(db: Database, vaultPath: string): unknown[] {
  const copy = Database.deserialize(db.serialize());
  try {
    rebuildDerived(copy, vaultPath);
    return graphRows(copy);
  } finally {
    copy.close();
  }
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

for (const seed of [1, 2, 3]) {
  test(`refreshing and removing single pages tracks a full rebuild through ${seed} random edits`, async () => {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const db = searchDb();
    const vault = tempVault();
    disposers.push(() => db.close(), vault.dispose);
    const slugs: string[] = [];
    /** Pages the writer may still rewrite; a hand edit or an archive ends that. */
    const rewritable = new Set<string>();
    const body = () => {
      const targets = [...TITLES.map((title) => `[[${title}]]`), ...slugs.map((slug) => `[[fact:${slug}]]`), ...slugs.map((slug) => `[[facts/${slug}]]`)];
      return `Prose. ${Array.from({ length: Math.floor(next() * 4) }, () => pick(targets)).join(" ")}`;
    };
    const write = async (slug: string) => {
      await recordedPage(db, vault.path, `facts/${slug}.md`, {
        id: `fact:${slug}`, title: pick(TITLES), type: "fact", status: "active", sensitivity: pick(["public", "personal", "private"]), taint: "clean",
        subjects: [pick(["person:ada", "fact:p1", "fact:p2"])],
      }, body());
      refreshDerivedPage(db, listCanonPages(vault.path).find((page) => page.id === `fact:${slug}`)!, vault.path);
    };
    await write("p0");
    slugs.push("p0");
    rewritable.add("p0");
    rebuildDerived(db, vault.path);
    let filled = 0;
    const walked = spyOn(graph, "refreshPageEdges");
    for (let step = 0; step < 30; step += 1) {
      const operation = next();
      const slug = pick(slugs);
      const page = listCanonPages(vault.path).find((candidate) => candidate.id === `fact:${slug}`);
      if (operation < 0.4 || page === undefined) {
        const created = `p${slugs.length}`;
        slugs.push(created);
        rewritable.add(created);
        await write(created);
      } else if (operation < 0.6 && rewritable.has(slug)) {
        await write(slug);
      } else if (operation < 0.75) {
        rewritable.delete(slug);
        const archived = { ...page, data: { ...page.data, status: page.data["status"] === "active" ? "archived" : "active" } };
        writeFileSync(page.path, serializePage({ data: archived.data, body: page.body }));
        refreshDerivedPage(db, listCanonPages(vault.path).find((candidate) => candidate.id === page.id)!, vault.path);
      } else if (operation < 0.85) {
        rewritable.delete(slug);
        unlinkSync(page.path);
        removeDerivedPage(db, page.id, vault.path);
      } else if (operation < 0.92) {
        // An edit no refresh has seen yet: the next page's write must notice it.
        rewritable.delete(slug);
        appendFileSync(page.path, "\nAn owner note nothing has refreshed.\n");
        const created = `p${slugs.length}`;
        slugs.push(created);
        rewritable.add(created);
        await write(created);
      } else {
        rewritable.delete(slug);
        appendFileSync(page.path, "\nAn owner note the writer never recorded.\n");
        refreshDerivedPage(db, listCanonPages(vault.path).find((candidate) => candidate.id === page.id)!, vault.path);
      }
      expect(graphRows(db)).toEqual(rebuiltRows(db, vault.path));
      filled += graphRows(db).length;
    }
    expect(filled).toBeGreaterThan(0);
    // Only a write that follows an edit the registry has not seen costs a walk;
    // every other refresh is answered from the registry.
    expect(walked.mock.calls.length).toBeLessThan(12);
    walked.mockRestore();
    expect(readDerivedMeta(db, "graph")).not.toBeNull();
  }, 120_000);
}

test("the registry follows a page that moves, and a purge clears it", async () => {
  const db = searchDb();
  const vault = tempVault();
  disposers.push(() => db.close(), vault.dispose);
  for (const slug of ["one", "two"]) {
    await recordedPage(db, vault.path, `facts/${slug}.md`, {
      id: `fact:${slug}`, title: slug, type: "fact", status: "active", sensitivity: "personal", taint: "clean",
    }, "See [[two]] and [[one]].");
  }
  rebuildDerived(db, vault.path);
  const walked = spyOn(graph, "refreshPageEdges");
  const filesOf = () => db.query<{ rel_path: string }, []>("SELECT rel_path FROM graph_files ORDER BY rel_path").all().map((row) => row.rel_path);

  // The same page under a new path: no other file changed, so no walk, and no stale file row.
  const one = listCanonPages(vault.path).find((page) => page.id === "fact:one")!;
  writeFileSync(join(vault.path, "facts/moved.md"), serializePage({ data: one.data, body: one.body }));
  unlinkSync(one.path);
  refreshDerivedPage(db, listCanonPages(vault.path).find((page) => page.id === "fact:one")!, vault.path);
  expect(filesOf()).toEqual(["facts/moved.md", "facts/two.md"]);
  refreshDerivedPage(db, listCanonPages(vault.path).find((page) => page.id === "fact:two")!, vault.path);
  expect(walked).not.toHaveBeenCalled();
  expect(graphRows(db)).toEqual(rebuiltRows(db, vault.path));
  walked.mockRestore();

  // Purge withdraws the derived relations of erased evidence; the registry, which names it, goes too.
  expect(graph.graphRegistryReady(db)).toBe(true);
  graph.removeHeldPageEdges(db, listCanonPages(vault.path));
  expect(graph.graphRegistryReady(db)).toBe(false);
  for (const table of ["graph_pages", "graph_links", "graph_files"]) {
    expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  refreshDerivedPage(db, listCanonPages(vault.path)[0]!, vault.path);
  expect(graph.graphRegistryReady(db)).toBe(true);
  expect(graphRows(db)).toEqual(rebuiltRows(db, vault.path));
}, 60_000);

test("an older disposable registry is reconciled before indexed resolution", async () => {
  const db = searchDb();
  const vault = tempVault();
  disposers.push(() => db.close(), vault.dispose);
  await recordedPage(db, vault.path, "facts/one.md", {
    id: "fact:one", title: "One", type: "fact", status: "active", sensitivity: "personal", taint: "clean",
  }, "See [[One]].");
  rebuildDerived(db, vault.path);
  const before = graphRows(db);
  db.exec("DROP TABLE graph_page_keys");
  initGraph(db);
  expect(graph.graphRegistryReady(db)).toBe(false);
  refreshDerivedPage(db, listCanonPages(vault.path)[0]!, vault.path);
  expect(graph.graphRegistryReady(db)).toBe(true);
  expect(graphRows(db)).toEqual(before);
});

test("replacing an identity at the same path removes the old page's edges", async () => {
  const db = searchDb();
  const vault = tempVault();
  disposers.push(() => db.close(), vault.dispose);
  for (const slug of ["one", "two"]) {
    await recordedPage(db, vault.path, `facts/${slug}.md`, {
      id: `fact:${slug}`, title: slug, type: "fact", status: "active", sensitivity: "personal", taint: "clean",
    }, slug === "one" ? "See [[two]]." : "See [[fact:one]] and [[one]].");
  }
  rebuildDerived(db, vault.path);
  expect(db.query("SELECT 1 FROM graph_edges WHERE src='fact:one'").get()).not.toBeNull();
  const prior = listCanonPages(vault.path).find(page => page.id === "fact:one")!;
  writeFileSync(prior.path, serializePage({ data: { ...prior.data, id: "fact:replacement" }, body: prior.body }));
  const replacement = listCanonPages(vault.path).find(page => page.id === "fact:replacement")!;
  refreshDerivedPage(db, replacement, vault.path);
  expect(graphRows(db)).toEqual(rebuiltRows(db, vault.path));
  expect(db.query("SELECT 1 FROM graph_edges WHERE src='fact:one' OR dst='fact:one'").get()).toBeNull();
});
