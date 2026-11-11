import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { reconcileDerivedPages, reconcileDerivedPagesWhenChanged } from "../../src/derived-refresh";
import { refreshPageEdgesBatch, replacePageEdges } from "../../src/graph/graph";
import { serveGraph } from "../../src/serving/graph";
import { listCanonPagesReport } from "../../src/vault/pages";
import { recordedPage } from "../helpers/recorded-page";
import { reconcileFixture } from "./reconcile-fixture";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

const fact = (id: string, title = id) => ({ id: `fact:${id}`, title, type: "fact", status: "active", sensitivity: "public", taint: "clean" });
const BROKEN = "---\nid: fact:broken\n---\nNo schema.";

/** Refreshes as the serve loop does until one is skipped. */
function settle(db: Database, vault: string): void {
  let passes = 0;
  while (passes < 4 && reconcileDerivedPagesWhenChanged(db, vault, Date.now() + 5_000)) passes += 1;
  expect(passes).toBeLessThanOrEqual(3);
}

test("a page filed while another page is unreadable gets its backlinks from the next refresh", async () => {
  const f = await reconcileFixture(cleanup);
  writeFileSync(join(f.vault, "facts/broken.md"), BROKEN);
  settle(f.db, f.vault);
  const linksToCup = () => f.db.query<{ src: string; dst: string }, []>("SELECT src, dst FROM graph_edges WHERE kind='wikilink' ORDER BY src").all();
  expect(linksToCup()).toEqual([{ src: "fact:kettle", dst: "Cup" }, { src: "fact:tea", dst: "Cup" }]);
  // After a walk that skipped a file the writer projects only its own page: the pages naming it wait for a refresh.
  await recordedPage(f.db, f.vault, "facts/cup.md", fact("cup", "Cup"), "A cup.");
  expect(linksToCup()).toEqual([{ src: "fact:kettle", dst: "Cup" }, { src: "fact:tea", dst: "Cup" }]);
  settle(f.db, f.vault);
  expect(linksToCup()).toEqual([{ src: "fact:kettle", dst: "fact:cup" }, { src: "fact:tea", dst: "fact:cup" }]);
  const served = await serveGraph({ db: f.db, vaultPath: f.vault, principal: OWNER }, { id: "fact:cup" });
  expect(served.data?.edges.filter(edge => edge.kind === "wikilink").map(edge => edge.src).sort()).toEqual(["fact:kettle", "fact:tea"]);
  // The registry was right all along; the edges were not. With both right the graph stays degraded and the refresh skips.
  expect(f.db.query("SELECT status FROM derived_meta WHERE layer='graph'").get()).toEqual({ status: "degraded" });
  expect(reconcileDerivedPagesWhenChanged(f.db, f.vault, Date.now() + 5_000)).toBe(false);
});

const edges = (db: Database) => JSON.stringify(db.query("SELECT src, dst, kind, sensitivity, dest_sensitivity, taint, authority, provenance FROM graph_edges ORDER BY src, dst, kind").all());

/** The edges left by projecting every known page, which is what a pass writes for a graph it does not trust. */
function projectedEdges(db: Database, vault: string): string {
  const report = listCanonPagesReport(vault);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (report.skipped.length === 0) replacePageEdges(db, report.pages, report.signatures);
    else refreshPageEdgesBatch(db, report.pages, report.pages, report.skipped.length, report.signatures);
    return edges(db);
  } finally { db.exec("ROLLBACK"); }
}

const NAMES = ["tea", "kettle", "cup", "saucer", "spoon"];
const DEGRADED = {
  "an unreadable page": (vault: string) => writeFileSync(join(vault, "facts/broken.md"), BROKEN),
  "a live page with no receipt": (vault: string) => writeFileSync(join(vault, "facts/ghost.md"),
    "---\nid: fact:ghost\ntitle: Ghost\ntype: fact\nstatus: active\nsensitivity: public\ntaint: clean\nsources: []\n---\nNo receipt, links [[tea]].\n"),
};

for (const [label, degrade] of Object.entries(DEGRADED)) {
  test(`a degraded graph is left alone only while its edges are what a projection of every page writes: ${label}`, async () => {
    const f = await reconcileFixture(cleanup);
    degrade(f.vault);
    for (let pass = 0; pass < 3; pass += 1) reconcileDerivedPages(f.db, f.vault);
    expect(f.db.query("SELECT status FROM derived_meta WHERE layer='graph'").get()).toEqual({ status: "degraded" });
    let seed = 7;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pick = () => NAMES[Math.floor(next() * NAMES.length)]!;
    for (let step = 0; step < 10; step += 1) {
      // Retitles and changed links: each moves how other pages' links resolve.
      const name = pick();
      const title = next() < 0.4 ? `${name} ${Math.floor(next() * 3)}` : name;
      const links = [pick(), pick(), next() < 0.3 ? "Ghost" : pick()].map(target => `[[${target}]]`).join(" ");
      await recordedPage(f.db, f.vault, `facts/${name}.md`, fact(name, title), `${name} at step ${step} ${links}.`);
      reconcileDerivedPages(f.db, f.vault);
      expect(edges(f.db)).toBe(projectedEdges(f.db, f.vault));
      // With the edges right, the next pass has nothing to project.
      expect(reconcileDerivedPages(f.db, f.vault)).toBe(false);
    }
  }, 120_000);
}

test("an edge lost from or left in a degraded graph is repaired by the next pass", async () => {
  const f = await reconcileFixture(cleanup);
  DEGRADED["a live page with no receipt"](f.vault);
  for (let pass = 0; pass < 3; pass += 1) reconcileDerivedPages(f.db, f.vault);
  const projected = edges(f.db);
  const stray = "INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance) VALUES ('fact:gone', 'tea', 'wikilink', 'public', 'clean', 'canon', '[]')";

  f.db.query("DELETE FROM graph_edges WHERE src='fact:tea' AND kind='wikilink'").run();
  expect(reconcileDerivedPages(f.db, f.vault)).toBe(true);
  expect(edges(f.db)).toBe(projected);
  // A complete walk knows every page, so an edge from none of them goes.
  f.db.query(stray).run();
  expect(reconcileDerivedPages(f.db, f.vault)).toBe(true);
  expect(edges(f.db)).toBe(projected);
  expect(reconcileDerivedPages(f.db, f.vault)).toBe(false);

  // A walk that skipped a file cannot say whose edge that is, and keeps it.
  DEGRADED["an unreadable page"](f.vault);
  for (let pass = 0; pass < 3; pass += 1) reconcileDerivedPages(f.db, f.vault);
  f.db.query(stray).run();
  // Only the edge count in the health stamp moves.
  reconcileDerivedPages(f.db, f.vault);
  expect(edges(f.db)).toContain("fact:gone");
  expect(reconcileDerivedPages(f.db, f.vault)).toBe(false);
  f.db.query("DELETE FROM graph_edges WHERE src='fact:tea' AND kind='wikilink'").run();
  expect(reconcileDerivedPages(f.db, f.vault)).toBe(true);
  expect(edges(f.db)).toBe(projectedEdges(f.db, f.vault));
  expect(edges(f.db)).toContain("fact:gone");
});
