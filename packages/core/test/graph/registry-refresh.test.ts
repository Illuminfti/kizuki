import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as graph from "../../src/graph/graph";
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
