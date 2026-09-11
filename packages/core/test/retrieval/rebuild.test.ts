import { afterEach, expect, test } from "bun:test";
import { truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRetrievalDocuments, rebuildRetrieval } from "../../src/retrieval/rebuild";
import { serveFixture } from "../serving/helpers";
import { insertClaim } from "../../src/claims/store";
import { claimInput, putEvent, FixtureVectorPort } from "../claims/helpers";
import type { RetrievalDoc } from "../../src/contracts/retrieval";
import type { Fixture } from "../serving/helpers";
import { tryWriteFlock } from "../../src/serve/flock";
import type { Database } from "bun:sqlite";
let fixture: Fixture | undefined;
afterEach(() => fixture?.dispose());

function snapshotSearch(db: Database) {
  return {
    documents: db.query("SELECT * FROM search_documents ORDER BY doc_id").all(),
    docs: db.query("SELECT * FROM search_docs ORDER BY doc_id").all(),
    meta: db.query("SELECT * FROM derived_meta WHERE layer='search'").all(),
  };
}

function snapshotGraph(db: Database) {
  return db.query("SELECT * FROM graph_edges ORDER BY src, dst, kind").all();
}

test("recorded canon has receipt dates and stable projections", async () => {
  fixture = await serveFixture();
  const docs = readRetrievalDocuments(fixture.db, fixture.vaultPath);
  const pages = docs.filter(doc => doc.kind === "page");
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    expect(Number.isFinite(Date.parse(page.updated_at ?? ""))).toBe(true);
    expect(page.occurred_at).toBeNull();
    expect(page.authority).toBe("model_inference");
  }
  expect(readRetrievalDocuments(fixture.db, fixture.vaultPath)).toEqual(docs);
});

test("unreadable canon refuses before the selected engine or lexical floor changes", async () => {
  fixture = await serveFixture();
  const before = fixture.db.query("SELECT * FROM search_documents ORDER BY doc_id").all();
  writeFileSync(join(fixture.vaultPath, "facts", "malformed.md"), "---\ninvalid: [\n---\nsecret");
  let called = false;
  const port = { rebuildFromDocuments: async () => { called = true; } } as never;
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, port)).rejects.toThrow();
  expect(called).toBe(false);
  expect(fixture.db.query("SELECT * FROM search_documents ORDER BY doc_id").all()).toEqual(before);
});

test("source byte limits refuse before a sparse oversized canon file can be read or swapped", async () => {
  fixture = await serveFixture();
  const path = join(fixture.vaultPath, "facts", "oversized.md");
  writeFileSync(path, "");
  truncateSync(path, 64 * 1024 * 1024 + 1);
  let called = false;
  const port = { rebuildFromDocuments: async () => { called = true; } } as never;
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, port)).rejects.toThrow("rebuild corpus exceeds");
  expect(called).toBe(false);
});

test("the default rebuild reconstructs its existing lexical floor", async () => {
  fixture = await serveFixture();
  const result = await rebuildRetrieval(fixture.db, fixture.vaultPath);
  expect(result.store).toBe("kizuki.retrieval.fts5");
  const actual = fixture.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_documents").get()!.n;
  expect(actual).toBeGreaterThan(0);
  expect(result.documents).toBe(actual);
  expect(result).toMatchObject({ backend: "sqlite-floor", floor_documents: actual });
});


test("selected port reports its validated corpus including readable claims separately from floor rows", async () => {
  fixture = await serveFixture();
  const event = putEvent(fixture.db);
  const stored = await insertClaim({ db: fixture.db }, claimInput(event));
  if (stored.outcome !== "stored") throw new Error("synthetic claim was not stored");
  class RebuildPort extends FixtureVectorPort {
    async rebuildFromDocuments(docs: readonly RetrievalDoc[]) {
      this.docs.clear();
      await this.upsert(docs);
    }
  }
  const port = new RebuildPort();
  const result = await rebuildRetrieval(fixture.db, fixture.vaultPath, port);
  expect(port.docs.get(`claim:${stored.claim.claim_id}`)).toMatchObject({ kind: "claim", authority: stored.claim.authority });
  expect(result.documents).toBe(port.docs.size);
  const actual = fixture.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_documents").get()!.n;
  expect(result).toMatchObject({ backend: "retrieval-port", floor_documents: actual, store: port.descriptor.id });
  expect(fixture.db.query("SELECT 1 FROM search_documents WHERE doc_id=?").all(`claim:${stored.claim.claim_id}`)).toHaveLength(0);
  fixture.db.query("UPDATE claims SET sensitivity=NULL WHERE claim_id=?").run(stored.claim.claim_id);
  const after = await rebuildRetrieval(fixture.db, fixture.vaultPath, port);
  expect(port.docs.has(`claim:${stored.claim.claim_id}`)).toBe(false);
  expect(after.documents).toBe(result.documents - 1);
  expect(after.floor_documents).toBe(actual);
});

test("graph-only rebuild restores graph edges without touching search", async () => {
  fixture = await serveFixture();
  const search = snapshotSearch(fixture.db);
  const graph = snapshotGraph(fixture.db);
  expect(graph.length).toBeGreaterThan(0);
  expect(search.documents.length).toBeGreaterThan(0);
  fixture.db.exec("DELETE FROM graph_edges");
  expect(snapshotGraph(fixture.db)).toEqual([]);
  const result = await rebuildRetrieval(fixture.db, fixture.vaultPath, undefined, { layer: "graph" });
  expect(snapshotGraph(fixture.db)).toEqual(graph);
  expect(snapshotSearch(fixture.db)).toEqual(search);
  expect(result).toMatchObject({ backend: "sqlite-floor", store: "kizuki.retrieval.fts5" });
  expect(result.documents).toBeGreaterThan(0);
});

test("graph-only rebuild refuses malformed canon and a busy writer before mutation", async () => {
  fixture = await serveFixture();
  const graph = snapshotGraph(fixture.db);
  const search = snapshotSearch(fixture.db);
  writeFileSync(join(fixture.vaultPath, "facts", "malformed.md"), "---\ninvalid: [\n---\nsecret");
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, undefined, { layer: "graph" })).rejects.toThrow(
    "canon is unreadable; derived rebuild refused",
  );
  expect(snapshotGraph(fixture.db)).toEqual(graph);
  expect(snapshotSearch(fixture.db)).toEqual(search);
  const lock = tryWriteFlock(fixture.vaultPath);
  expect(lock).not.toBeNull();
  try {
    await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, undefined, { layer: "graph" })).rejects.toThrow(
      "canon writer is busy; retry rebuild",
    );
    expect(snapshotGraph(fixture.db)).toEqual(graph);
    expect(snapshotSearch(fixture.db)).toEqual(search);
  } finally {
    lock?.release();
  }
});

test("graph-only rebuild refuses a configured retrieval engine before mutation", async () => {
  fixture = await serveFixture();
  const graph = snapshotGraph(fixture.db);
  const search = snapshotSearch(fixture.db);
  let called = false;
  const port = { rebuildFromDocuments: async () => { called = true; } } as never;
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, port, { layer: "graph" })).rejects.toThrow(
    "partial layer rebuild is not supported for a configured retrieval engine",
  );
  expect(called).toBe(false);
  expect(snapshotGraph(fixture.db)).toEqual(graph);
  expect(snapshotSearch(fixture.db)).toEqual(search);
});
