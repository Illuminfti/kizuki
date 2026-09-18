import { afterEach, expect, test } from "bun:test";
import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRetrievalDocuments, rebuildRetrieval } from "../../src/retrieval/rebuild";
import { recordedPage, serveFixture } from "../serving/helpers";
import { insertClaim } from "../../src/claims/store";
import { claimInput, putEvent, FixtureVectorPort } from "../claims/helpers";
import { computeOriginBinding } from "../../src/ledger/event-origin-binding";
import { computeContentHash, sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import type { CaptureEventInput } from "../../src/contracts/event";
import type { RetrievalDoc, RetrievalPort, RetrievalQuery } from "../../src/contracts/retrieval";
import type { Fixture } from "../serving/helpers";
import { tryWriteFlock } from "../../src/serve/flock";
import type { Database } from "bun:sqlite";
import { createFts5RetrievalPort, FTS5_RETRIEVAL_DESCRIPTOR } from "../../src/retrieval";
import { temporaryPortContext } from "../contracts/fixtures";
let fixture: Fixture | undefined;
afterEach(() => fixture?.dispose());

function seedBulkEvents(db: Database, count: number): void {
  const insert = db.prepare(`INSERT INTO events (
    event_id, connector_id, source_record_id, kind, occurred_at, observed_at,
    text, subjects, sensitivity_hint, deleted, attachments, metadata, content_hash,
    accepted_at, content_hash_version, text_hash, origin, origin_binding_version,
    origin_binding_kind, origin_binding
  ) VALUES (?, 'fixture', ?, 'message', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z',
    'bulkcatchupword', '[]', NULL, 0, '[]', '{}', ?, '2026-09-01T00:00:01.000Z', 2, ?,
    'external', 1, 'capture', ?)`);
  const textHash = sha256Hex("bulkcatchupword");
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const eventId = ulid();
      const source = `bulk-${index}`;
      const input: CaptureEventInput = {
        schema: "kizuki.event/v1",
        connector_id: "fixture",
        source_record_id: source,
        kind: "message",
        occurred_at: "2026-09-01T00:00:00Z",
        observed_at: "2026-09-01T00:00:00Z",
        text: "bulkcatchupword",
        subjects: [],
        deleted: false,
        attachments: [],
        metadata: {},
      };
      const contentHash = computeContentHash(input);
      const originBinding = computeOriginBinding(
        { event_id: eventId, content_hash_version: 2, content_hash: contentHash, text_hash: textHash, origin: "external" },
        "2026-09-01T00:00:01.000Z",
        "capture",
        null,
      );
      insert.run(eventId, source, contentHash, textHash, originBinding);
    }
  })();
}

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

function snapshotGraphMeta(db: Database) {
  return db.query("SELECT * FROM derived_meta WHERE layer='graph'").all();
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

test("rebuild snapshots and selected ports use locale-independent document order", async () => {
  fixture = await serveFixture();
  const pageIds = ["fact:order-a", "fact:order-Z"];
  for (const [index, id] of pageIds.entries()) {
    await recordedPage(fixture.db, fixture.vaultPath, `facts/order-${index}.md`, {
      id, title: id, type: "fact", status: "active", sensitivity: "public", taint: "clean",
    }, `Ordering fixture ${id}.`);
  }
  const expected = ["page:fact:order-Z", "page:fact:order-a"];
  const selected = (docs: readonly RetrievalDoc[]) => docs.map(doc => doc.doc_id)
    .filter(id => id.startsWith("page:fact:order-"));
  const snapshot = readRetrievalDocuments(fixture.db, fixture.vaultPath);
  expect(selected(snapshot)).toEqual(expected);
  expect(snapshot.map(doc => doc.doc_id)).toEqual(snapshot.map(doc => doc.doc_id).sort());
  class OrderedPort extends FixtureVectorPort {
    async rebuildFromDocuments(docs: readonly RetrievalDoc[]) {
      expect(selected(docs)).toEqual(expected);
      this.docs.clear();
      await this.upsert(docs);
    }
  }
  const port = new OrderedPort();
  await rebuildRetrieval(fixture.db, fixture.vaultPath, port);
  expect([...port.docs.values()]).toEqual(snapshot);
  await rebuildRetrieval(fixture.db, fixture.vaultPath, port);
  expect([...port.docs.values()]).toEqual(snapshot);
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

test("rebuild corpus bound counts nested archive pages and still excludes root archive", async () => {
  fixture = await serveFixture();
  mkdirSync(join(fixture.vaultPath, "archive"), { recursive: true, mode: 0o700 });
  const rootArchive = join(fixture.vaultPath, "archive", "oversized.md");
  writeFileSync(rootArchive, "");
  truncateSync(rootArchive, 64 * 1024 * 1024 + 1);
  await rebuildRetrieval(fixture.db, fixture.vaultPath);
  mkdirSync(join(fixture.vaultPath, "facts", "archive"), { recursive: true, mode: 0o700 });
  const nested = join(fixture.vaultPath, "facts", "archive", "oversized.md");
  writeFileSync(nested, "");
  truncateSync(nested, 64 * 1024 * 1024 + 1);
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

test("sqlite-floor rebuild completes a 12000-record corpus that a port snapshot still refuses", async () => {
  fixture = await serveFixture();
  seedBulkEvents(fixture.db, 12_000);
  const port = { rebuildFromDocuments: async () => { throw new Error("engine should not snapshot"); } } as never;
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, port)).rejects.toThrow(/rebuild corpus exceeds.*records/);
  const result = await rebuildRetrieval(fixture.db, fixture.vaultPath);
  expect(result.backend).toBe("sqlite-floor");
  expect(result.documents).toBeGreaterThan(12_000);
}, 180_000);


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

test("search-only rebuild restores lexical rows without touching graph", async () => {
  fixture = await serveFixture();
  const search = snapshotSearch(fixture.db);
  const graph = snapshotGraph(fixture.db);
  const graphMeta = snapshotGraphMeta(fixture.db);
  expect(graph.length).toBeGreaterThan(0);
  expect(search.documents.length).toBeGreaterThan(0);
  fixture.db.exec("DELETE FROM search_documents");
  expect(fixture.db.query("SELECT count(*) AS n FROM search_documents").get()).toEqual({ n: 0 });
  const result = await rebuildRetrieval(fixture.db, fixture.vaultPath, undefined, { layer: "search" });
  const restored = snapshotSearch(fixture.db);
  expect(restored.documents).toEqual(search.documents);
  expect(restored.docs).toEqual(search.docs);
  expect(snapshotGraph(fixture.db)).toEqual(graph);
  expect(snapshotGraphMeta(fixture.db)).toEqual(graphMeta);
  expect(result).toMatchObject({ backend: "sqlite-floor", store: "kizuki.retrieval.fts5" });
  expect(result.documents).toBe(search.documents.length);
});

test("search-only rebuild refuses malformed canon and a busy writer before mutation", async () => {
  fixture = await serveFixture();
  const graph = snapshotGraph(fixture.db);
  const search = snapshotSearch(fixture.db);
  writeFileSync(join(fixture.vaultPath, "facts", "malformed.md"), "---\ninvalid: [\n---\nsecret");
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, undefined, { layer: "search" })).rejects.toThrow(
    "canon is unreadable; derived rebuild refused",
  );
  expect(snapshotGraph(fixture.db)).toEqual(graph);
  expect(snapshotSearch(fixture.db)).toEqual(search);
  const lock = tryWriteFlock(fixture.vaultPath);
  expect(lock).not.toBeNull();
  try {
    await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, undefined, { layer: "search" })).rejects.toThrow(
      "canon writer is busy; retry rebuild",
    );
    expect(snapshotGraph(fixture.db)).toEqual(graph);
    expect(snapshotSearch(fixture.db)).toEqual(search);
  } finally {
    lock?.release();
  }
});

test("search-only rebuild refuses a configured retrieval engine before mutation", async () => {
  fixture = await serveFixture();
  const graph = snapshotGraph(fixture.db);
  const search = snapshotSearch(fixture.db);
  let called = false;
  const port = { rebuildFromDocuments: async () => { called = true; } } as never;
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, port, { layer: "search" })).rejects.toThrow(
    "partial layer rebuild is not supported for a configured retrieval engine",
  );
  expect(called).toBe(false);
  expect(snapshotGraph(fixture.db)).toEqual(graph);
  expect(snapshotSearch(fixture.db)).toEqual(search);
});

function lexicalQuery(text: string): RetrievalQuery {
  return {
    text,
    mode: "lexical",
    scope: {},
    ceiling: "private",
    limit: 100,
    deadline_ms: 5_000,
  };
}

async function hitIds(port: RetrievalPort, text: string): Promise<string[]> {
  return (await port.search(lexicalQuery(text))).hits.map(({ doc_id }) => doc_id);
}

test("rebuild fails when the selected store drops a snapshot document", async () => {
  fixture = await serveFixture();
  class DroppingPort extends FixtureVectorPort {
    async rebuildFromDocuments(docs: readonly RetrievalDoc[]) {
      this.docs.clear();
      await this.upsert(docs.slice(1));
    }
  }
  const port = new DroppingPort();
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, port)).rejects.toThrow(
    "rebuild document set did not match the authoritative snapshot",
  );
});

test("rebuild verifies the snapshot document set and golden recall", async () => {
  fixture = await serveFixture();
  const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  const port = createFts5RetrievalPort(temporary.ctx);
  try {
    const snapshot = readRetrievalDocuments(fixture.db, fixture.vaultPath);
    expect(snapshot.length).toBeGreaterThan(1);
    await port.upsert(snapshot);
    const ids = snapshot.map((doc) => doc.doc_id).sort();
    const incremental = (await port.verifyAbsent(ids)).found.slice().sort();
    expect(incremental).toEqual(ids);
    const incrementalGrace = await hitIds(port, "Grace");
    const incrementalKettle = await hitIds(port, "kettle");
    expect(incrementalGrace).toContain("page:person:grace");
    expect(incrementalKettle.length).toBeGreaterThan(0);

    const result = await rebuildRetrieval(fixture.db, fixture.vaultPath, port);
    expect(result.documents).toBe(snapshot.length);
    expect((await port.verifyAbsent(ids)).found.slice().sort()).toEqual(ids);
    const rebuiltGrace = await hitIds(port, "Grace");
    const rebuiltKettle = await hitIds(port, "kettle");
    expect(rebuiltGrace).toEqual(incrementalGrace);
    expect(rebuiltKettle).toEqual(incrementalKettle);

    const again = await rebuildRetrieval(fixture.db, fixture.vaultPath, port);
    expect(again.documents).toBe(snapshot.length);
    expect((await port.verifyAbsent(ids)).found.slice().sort()).toEqual(ids);
    expect(await hitIds(port, "Grace")).toEqual(rebuiltGrace);
    expect(await hitIds(port, "kettle")).toEqual(rebuiltKettle);
  } finally {
    await port.close();
    temporary.cleanup();
  }
});
