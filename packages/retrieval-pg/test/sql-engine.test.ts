import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openEmbeddedRetrievalPort, McpEngineSurface } from "../src/index";
import { SqlStore } from "../src/sql-store";
import { temporaryPortContext, FixtureEmbeddingPort, SYNTHETIC_DOCS, SYNTHETIC_QUERY, FIXTURE_SPACE } from "./helpers";
import type { Chunk, RetrievalDoc } from "@kizuki/core";
setDefaultTimeout(60000);
const doc = (id: string, extras: Partial<RetrievalDoc> = {}): RetrievalDoc => ({ ...SYNTHETIC_DOCS[0]!, doc_id: id, ...extras });
describe("real embedded SQL engine", () => {
  test("SQL indexes exist and planner can use HNSW, FTS and trigram after reopen", async () => {
    const fixture = temporaryPortContext();
    const port = await openEmbeddedRetrievalPort(fixture.ctx, { embedding: new FixtureEmbeddingPort() });
    try {
      await port.upsert([doc("page:compiler", { title: "Compiler architecture", text: "Compiler recipes for testing", sensitivity: "public" })]);
    }
    finally {
      await port.close();
    }
    const store = await SqlStore.open(fixture.ctx.data_dir);
    try {
      const indexes = JSON.stringify((await store.db.query("SELECT indexname FROM pg_indexes WHERE schemaname='public'")).rows);
      for (const index of ["retrieval_docs_fts_gin", "retrieval_docs_title_trgm", "retrieval_chunks_hnsw_cosine"]) {
        expect(indexes).toContain(index);
      }
      await store.db.exec("SET enable_seqscan=off");
      for (const [sql, index] of [
        ["EXPLAIN SELECT doc_id FROM retrieval_docs WHERE search_doc @@ plainto_tsquery('simple','compiler')", "retrieval_docs_fts_gin"],
        ["EXPLAIN SELECT doc_id FROM retrieval_docs WHERE title % 'compilor'", "retrieval_docs_title_trgm"],
        ["EXPLAIN SELECT chunk_id FROM retrieval_chunks ORDER BY embedding::vector(8) <=> '[1,0,0,0,0,0,0,0]' LIMIT 2", "retrieval_chunks_hnsw_cosine"],
      ]) {
        expect(JSON.stringify((await store.db.query(sql!)).rows)).toContain(index!);
      }
    }
    finally {
      await store.close();
      fixture.cleanup();
    }
  });
  test("scope precedes lexical and vector windows and typo rescue stays within ceiling", async () => {
    const fixture = temporaryPortContext();
    const port = await openEmbeddedRetrievalPort(fixture.ctx, { embedding: new FixtureEmbeddingPort() });
    try {
      const hidden = Array.from({ length: 205 }, (_, i) => doc(`page:hidden-${i}`, { title: "Compiler", sensitivity: "private", subjects: ["topic:secret"] }));
      await port.upsert([...hidden, doc("page:visible", { title: "Compiler architecture", text: "Visible lexical evidence", sensitivity: "public", subjects: ["topic:visible"] })]);
      for (const mode of ["lexical", "vector", "hybrid"] as const) {
        const result = await port.search({ ...SYNTHETIC_QUERY, mode, text: "compiler", scope: { subjects: ["topic:visible"] }, ceiling: "public", limit: 1, deadline_ms: 5000 });
        expect(result.hits.map(hit => hit.doc_id)).toEqual(["page:visible"]);
      }
      const typo = await port.search({ ...SYNTHETIC_QUERY, text: "compilor", scope: {}, ceiling: "public", deadline_ms: 5000 });
      expect(typo.hits.map(hit => hit.doc_id)).toEqual(["page:visible"]);
    }
    finally {
      await port.close();
      fixture.cleanup();
    }
  });
  test("legacy JSON is never served and a failed authoritative rebuild preserves active SQL", async () => {
    const fixture = temporaryPortContext();
    const legacy = join(fixture.ctx.data_dir, "store", "docs.json");
    mkdirSync(join(fixture.ctx.data_dir, "store"), { recursive: true });
    writeFileSync(legacy, JSON.stringify([doc("page:legacy")]));
    const port = await openEmbeddedRetrievalPort(fixture.ctx);
    try {
      expect((await port.health()).status).toBe("unavailable");
      await expect(port.search(SYNTHETIC_QUERY)).rejects.toMatchObject({ code: "unavailable" });
      expect(existsSync(legacy)).toBe(true);
      await port.rebuildFromDocuments([doc("page:active")]);
      expect(existsSync(legacy)).toBe(false);
      async function* failing() { yield doc("page:replacement"); throw new Error("synthetic source unavailable"); }
      await expect(port.rebuildFromDocuments(failing())).rejects.toThrow("synthetic source unavailable");
      expect((await port.search(SYNTHETIC_QUERY)).hits.map(hit => hit.doc_id)).toEqual(["page:active"]);
      await port.rebuildFromDocuments([doc("page:active")]);
      expect((await port.search(SYNTHETIC_QUERY)).hits.map(hit => hit.doc_id)).toEqual(["page:active"]);
    }
    finally {
      await port.close();
      fixture.cleanup();
    }
  });
  test("removal during a delayed embed commits immediately and stale model output cannot resurrect a row", async () => {
    const fixture = temporaryPortContext();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => release = resolve);
    const started = new Promise<void>(resolve => entered = resolve);
    class Delayed extends FixtureEmbeddingPort {
      override async embedDocs(chunks: readonly Chunk[]) { entered(); await blocked; return super.embedDocs(chunks); }
    }
    const port = await openEmbeddedRetrievalPort(fixture.ctx, { embedding: new Delayed() });
    try {
      const write = port.upsert([doc("page:remove")]);
      await started;
      expect((await port.search(SYNTHETIC_QUERY)).hits).toHaveLength(1);
      await port.remove(["page:remove"]);
      release();
      await write;
      expect((await port.verifyAbsent(["page:remove"])).found).toEqual([]);
      expect((await port.neighbors({ entity_id: "person:grace" }, { hops: 2, limit: 10, ceiling: "private" })).edges).toEqual([]);
    }
    finally {
      release();
      await port.close();
      fixture.cleanup();
    }
  });
  test("same ID with changed embedding dimensions fails closed and keeps lexical usable", async () => {
    const fixture = temporaryPortContext();
    let port = await openEmbeddedRetrievalPort(fixture.ctx, { embedding: new FixtureEmbeddingPort() });
    try {
      await port.upsert([doc("page:space")]);
      await port.close();
      port = await openEmbeddedRetrievalPort(fixture.ctx, { embedding: new FixtureEmbeddingPort({ ...FIXTURE_SPACE, dims: 9 }) });
      expect((await port.search({ ...SYNTHETIC_QUERY, mode: "hybrid" })).degraded).toContain("embedding-space-mismatch");
      await expect(port.search({ ...SYNTHETIC_QUERY, mode: "vector" })).rejects.toMatchObject({ code: "space_mismatch" });
      expect((await port.search(SYNTHETIC_QUERY)).hits).toHaveLength(1);
    }
    finally {
      await port.close();
      fixture.cleanup();
    }
  });
  test("concurrent surface opens share one pending database open", async () => {
    const fixture = temporaryPortContext();
    const surface = new McpEngineSurface();
    try {
      const [a, b] = await Promise.all([surface.open(fixture.ctx), surface.open(fixture.ctx)]);
      expect(a).toBe(b);
      expect(surface.engineOpens).toBe(1);
    }
    finally {
      await surface.close();
      fixture.cleanup();
    }
  });
});
