import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildDerived } from "../src/derived";
import { readDerivedMeta, stampDerived } from "../src/derived-meta";
import { openLedger } from "../src/ledger/db";
import { recordedPage } from "./helpers/recorded-page";
import { searchDb, storedEvent, tempVault } from "./search/helpers";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

async function fixture() {
  const db = searchDb();
  const vault = tempVault();
  disposers.push(vault.dispose);
  const event = storedEvent(db, "event-one", { text: "Ledger tea note. Tea uses a Kettle." });
  await recordedPage(db, vault.path, "facts/tea.md", {
    id: "fact:tea",
    title: "Tea",
    type: "fact",
    status: "active",
    sensitivity: "personal",
    taint: "clean",
    subjects: ["person:ada"],
    sources: [event.event_id],
  }, "Tea uses a [[Kettle]].");
  return { db, vaultPath: vault.path };
}

function derivedCounts(db: ReturnType<typeof searchDb>) {
  return {
    search:
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM search_docs",
        )
        .get()?.count ?? 0,
    graph:
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM graph_edges",
        )
        .get()?.count ?? 0,
  };
}

describe("rebuildDerived", () => {
  test("derived_meta is created once and read back per layer", async () => {
    const { db, vaultPath } = await fixture();
    expect(readDerivedMeta(openLedger(":memory:"), "search")).toBeNull();
    rebuildDerived(db, vaultPath);
    expect(readDerivedMeta(db, "search")?.doc_count).toBe(2);
    expect(readDerivedMeta(db, "graph")?.doc_count).toBe(3);
    expect(readDerivedMeta(db, "search")?.generation).toBe(
      readDerivedMeta(db, "graph")?.generation,
    );
    expect(readDerivedMeta(db, "search")?.status).toBe("ok");
    expect(readDerivedMeta(db, "search")?.port_id).toBe("kizuki.retrieval.fts5");
    expect(readDerivedMeta(db, "graph")?.port_id).toBeNull();
  });

  test("rebuilds search and graph in one call", async () => {
    const { db, vaultPath } = await fixture();
    const result = rebuildDerived(db, vaultPath);

    expect(result.search).toMatchObject({ pages: 1, events: 1 });
    expect(result.graph).toMatchObject({ pages: 1, edges: 3 });
    expect(derivedCounts(db)).toEqual({ search: 2, graph: 3 });
  });

  test("restores identical counts after every derived table is deleted", async () => {
    const { db, vaultPath } = await fixture();
    rebuildDerived(db, vaultPath);
    const before = derivedCounts(db);

    db.exec(`
      DROP TABLE search_docs;
      DROP TABLE search_documents;
      DROP TABLE graph_edges;
      DROP TABLE derived_meta;
    `);
    rebuildDerived(db, vaultPath);

    expect(derivedCounts(db)).toEqual(before);
    expect(
      db
        .query<{ layer: string; doc_count: number }, []>(
          "SELECT layer, doc_count FROM derived_meta ORDER BY layer",
        )
        .all(),
    ).toEqual([
      { layer: "graph", doc_count: 3 },
      { layer: "search", doc_count: 2 },
    ]);
  });

  test("is idempotent across repeated one-command rebuilds", async () => {
    const { db, vaultPath } = await fixture();
    const first = rebuildDerived(db, vaultPath);
    const second = rebuildDerived(db, vaultPath);

    expect(second.search.pages).toBe(first.search.pages);
    expect(second.search.events).toBe(first.search.events);
    expect(second.graph.pages).toBe(first.graph.pages);
    expect(second.graph.edges).toBe(first.graph.edges);
  });

  test("malformed canon preserves the last complete search and graph generation", async () => {
    const { db, vaultPath } = await fixture();
    const prior = rebuildDerived(db, vaultPath);
    const documents = db.query("SELECT * FROM search_documents ORDER BY doc_id").all();
    const edges = db.query("SELECT * FROM graph_edges").all();
    writeFileSync(join(vaultPath, "facts", "orphan.md"), "no frontmatter\n");

    expect(() => rebuildDerived(db, vaultPath)).toThrow("canon is unreadable");
    expect(db.query("SELECT * FROM search_documents ORDER BY doc_id").all()).toEqual(documents);
    expect(db.query("SELECT * FROM graph_edges").all()).toEqual(edges);
    expect(readDerivedMeta(db, "search")?.generation).toBe(prior.generation);
    expect(readDerivedMeta(db, "graph")?.generation).toBe(prior.generation);
  });

  test("rejects a forged derived stamp", async () => {
    const { db } = await fixture();
    expect(() =>
      stampDerived(db, {
        layer: "search",
        generation: "g",
        rebuilt_at: "2026-09-02T12:00:00.000Z",
        doc_count: -1,
        source_count: 0,
        skipped_count: 0,
        status: "ok",
      }),
    ).toThrow(RangeError);
    expect(() =>
      stampDerived(db, {
        layer: "search",
        generation: "g",
        rebuilt_at: "2099-01-01T00:00:00.000Z",
        doc_count: 0,
        source_count: 0,
        skipped_count: 0,
        status: "ok",
      }),
    ).toThrow(RangeError);
  });
});
