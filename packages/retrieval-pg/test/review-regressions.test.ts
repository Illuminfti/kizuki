import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WriterLease, openEmbeddedRetrievalPort, McpEngineSurface } from "../src/index";
import { temporaryPortContext, FixtureEmbeddingPort, SYNTHETIC_DOCS, SYNTHETIC_QUERY } from "./helpers";

test("ownerless acquisition crash is reclaimable with a receipt", () => {
  const fixture = temporaryPortContext();
  mkdirSync(join(fixture.ctx.data_dir, "lease/held"), { recursive: true });
  const lease = new WriterLease(fixture.ctx.data_dir, { clock: () => "2099-01-01T00:00:00.000Z" });
  try { expect(lease.tryAcquire("recovery").action).toBe("reclaimed"); }
  finally { lease.release(); fixture.cleanup(); }
});

test("unrelated lease release cannot remove a live holder", () => {
  const fixture = temporaryPortContext();
  const owner = new WriterLease(fixture.ctx.data_dir);
  const other = new WriterLease(fixture.ctx.data_dir);
  try {
    owner.tryAcquire("owner");
    expect(other.release()).toBeNull();
    expect(owner.inspect().holder?.holder_id).toBe("owner");
    expect(() => other.tryAcquire("other")).toThrow();
  } finally { owner.release(); fixture.cleanup(); }
});

test("failed required embeddings retain the entire old active index", async () => {
  const fixture = temporaryPortContext();
  const embedding = new FixtureEmbeddingPort();
  const port = await openEmbeddedRetrievalPort(fixture.ctx, { embedding });
  try {
    await port.upsert([SYNTHETIC_DOCS[0]!]);
    const query = { ...SYNTHETIC_QUERY, mode: "vector" as const };
    const before = await port.search(query);
    embedding.failAfter = embedding.calls;
    await expect(port.rebuildFromDocuments([{ ...SYNTHETIC_DOCS[0]!, doc_id: "page:replacement" }])).rejects.toThrow();
    embedding.failAfter = null;
    expect((await port.search(query)).hits.map(hit => hit.doc_id)).toEqual(before.hits.map(hit => hit.doc_id));
    expect((await port.search(SYNTHETIC_QUERY)).hits.map(hit => hit.doc_id)).toEqual([SYNTHETIC_DOCS[0]!.doc_id]);
  } finally { await port.close(); fixture.cleanup(); }
});

test("engine metadata preserves creation and records embedded rebuild across reopen", async () => {
  const fixture = temporaryPortContext();
  const embedding = new FixtureEmbeddingPort();
  let now = "2026-09-05T00:00:00.000Z";
  const ctx = { ...fixture.ctx, clock: () => now };
  let port = await openEmbeddedRetrievalPort(ctx, { embedding });
  try {
    now = "2026-09-06T00:00:00.000Z";
    await port.rebuildFromDocuments([SYNTHETIC_DOCS[0]!]);
    const metadata = () => JSON.parse(readFileSync(join(ctx.data_dir, "engine.json"), "utf8"));
    expect(metadata().created_at).toBe("2026-09-05T00:00:00.000Z");
    expect(metadata().rebuilt_at).toBe(now);
    expect(metadata().space).toBe(embedding.space().id);
    await port.close();
    now = "2027-01-01T00:00:00.000Z";
    port = await openEmbeddedRetrievalPort(ctx, { embedding });
    expect(metadata().created_at).toBe("2026-09-05T00:00:00.000Z");
    expect(metadata().rebuilt_at).toBe("2026-09-06T00:00:00.000Z");
    expect(metadata().space).toBe(embedding.space().id);
  } finally { await port.close(); fixture.cleanup(); }
});

test("surface open waits for concurrent close and returns a fresh usable port", async () => {
  const fixture = temporaryPortContext();
  const surface = new McpEngineSurface();
  try {
    const first = await surface.open(fixture.ctx);
    const closing = surface.close();
    const reopened = surface.open(fixture.ctx);
    await closing;
    const second = await reopened;
    expect(second).not.toBe(first);
    expect((await second.health()).status).toBe("ready");
  } finally { await surface.close(); fixture.cleanup(); }
});

test("late embedding failure preserves old vectors and rebuild metadata", async () => {
  const fixture = temporaryPortContext();
  const embedding = new FixtureEmbeddingPort();
  const port = await openEmbeddedRetrievalPort(fixture.ctx, { embedding, chunk_tokens: 2, chunk_overlap: 0 });
  try {
    await port.upsert([SYNTHETIC_DOCS[0]!]);
    const before = readFileSync(join(fixture.ctx.data_dir, "engine.json"), "utf8");
    embedding.failAfter = embedding.calls + 1;
    await expect(port.rebuildFromDocuments([{ ...SYNTHETIC_DOCS[0]!, doc_id: "page:new" }])).rejects.toThrow();
    embedding.failAfter = null;
    expect((await port.search({ ...SYNTHETIC_QUERY, mode: "vector" })).hits.map(hit => hit.doc_id)).toEqual(["page:grace"]);
    expect(readFileSync(join(fixture.ctx.data_dir, "engine.json"), "utf8")).toBe(before);
    expect((await port.health()).status).toBe("ready");
  } finally { await port.close(); fixture.cleanup(); }
});

test("a failed vector-layer rebuild preserves the last usable vector index", async () => {
  const fixture = temporaryPortContext();
  const embedding = new FixtureEmbeddingPort();
  const port = await openEmbeddedRetrievalPort(fixture.ctx, { embedding });
  try {
    await port.upsert([SYNTHETIC_DOCS[0]!]);
    embedding.failAfter = embedding.calls;
    await expect(port.rebuildLayer("vector")).rejects.toThrow();
    embedding.failAfter = null;
    expect((await port.search({ ...SYNTHETIC_QUERY, mode: "vector" })).hits.map(hit => hit.doc_id)).toEqual(["page:grace"]);
  } finally { await port.close(); fixture.cleanup(); }
});

test("independent processes cannot simultaneously reclaim one dead lease", async () => {
  const fixture = temporaryPortContext();
  const { writeSyntheticHolder } = await import("../src/lease");
  writeSyntheticHolder(fixture.ctx.data_dir, {pid: 2147483647, holder_id: "dead", acquired_at: "2000-01-01T00:00:00Z", heartbeat_at: "2000-01-01T00:00:00Z"});
  const source = new URL("../src/lease.ts", import.meta.url).pathname;
  const script = `import { WriterLease } from ${JSON.stringify(source)};
    const lease = new WriterLease(${JSON.stringify(fixture.ctx.data_dir)});
    try { lease.tryAcquire('child'); console.log('acquired'); await Bun.sleep(200); lease.release(); }
    catch { console.log('busy'); }`;
  try {
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script], {stdout: "pipe", stderr: "pipe"}));
    const results = await Promise.all(children.map(async child => { const text = await new Response(child.stdout).text(); expect(await child.exited).toBe(0); return text.trim(); }));
    expect(results.sort()).toEqual(["acquired", "busy"]);
  } finally { fixture.cleanup(); }
});

test("SQL promotion failure rolls back staged documents and vectors together", async () => {
  const fixture = temporaryPortContext();
  const { SqlStore } = await import("../src/sql-store");
  const embedding = new FixtureEmbeddingPort();
  const port = await openEmbeddedRetrievalPort(fixture.ctx, { embedding });
  const original = SqlStore.prototype.writeDoc;
  try {
    await port.upsert([SYNTHETIC_DOCS[0]!]);
    SqlStore.prototype.writeDoc = async function (...args) {
      await original.apply(this, args);
      throw new Error("synthetic promotion interruption");
    };
    await expect(port.rebuildFromDocuments([{...SYNTHETIC_DOCS[0]!, doc_id: "page:new"}])).rejects.toThrow();
    SqlStore.prototype.writeDoc = original;
    expect((await port.search({...SYNTHETIC_QUERY, mode: "vector"})).hits.map(hit => hit.doc_id)).toEqual(["page:grace"]);
    expect((await port.search(SYNTHETIC_QUERY)).hits.map(hit => hit.doc_id)).toEqual(["page:grace"]);
    await port.rebuildFromDocuments([{...SYNTHETIC_DOCS[0]!, doc_id: "page:new"}]);
    expect((await port.search({...SYNTHETIC_QUERY, mode: "vector"})).hits.map(hit => hit.doc_id)).toEqual(["page:new"]);
  } finally { SqlStore.prototype.writeDoc = original; await port.close(); fixture.cleanup(); }
});

test("process death releases native ownership and permits receipted stale recovery", async () => {
  const fixture = temporaryPortContext();
  const source = new URL("../src/lease.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `import { WriterLease } from ${JSON.stringify(source)};
    new WriterLease(${JSON.stringify(fixture.ctx.data_dir)}).tryAcquire('crashing');
    console.log('held'); await Bun.sleep(10000);`], {stdout: "pipe", stderr: "pipe"});
  const reader = child.stdout.getReader();
  const lease = new WriterLease(fixture.ctx.data_dir, {clock: () => "2099-01-01T00:00:00.000Z"});
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    expect(() => lease.tryAcquire("too-early")).toThrow();
    child.kill("SIGKILL");
    await child.exited;
    expect(lease.tryAcquire("recovered").action).toBe("reclaimed");
    expect(lease.readReceipts().at(-1)?.previous?.holder_id).toBe("crashing");
  } finally { child.kill(); reader.releaseLock(); lease.release(); fixture.cleanup(); }
});

test("missing model cannot replace an existing embedded index with lexical-only state", async () => {
  const fixture = temporaryPortContext();
  let port = await openEmbeddedRetrievalPort(fixture.ctx, {embedding: new FixtureEmbeddingPort()});
  try {
    await port.upsert([SYNTHETIC_DOCS[0]!]);
    await port.close();
    port = await openEmbeddedRetrievalPort(fixture.ctx);
    await expect(port.rebuildFromDocuments([{...SYNTHETIC_DOCS[0]!, doc_id: "page:new"}])).rejects.toMatchObject({code: "unavailable"});
    expect((await port.search(SYNTHETIC_QUERY)).hits.map(hit => hit.doc_id)).toEqual(["page:grace"]);
    await port.close();
    port = await openEmbeddedRetrievalPort(fixture.ctx, {embedding: new FixtureEmbeddingPort()});
    expect((await port.search({...SYNTHETIC_QUERY, mode: "vector"})).hits.map(hit => hit.doc_id)).toEqual(["page:grace"]);
  } finally { await port.close(); fixture.cleanup(); }
});

test("fresh ownerless acquisition stays busy until the recovery bound", () => {
  const fixture = temporaryPortContext();
  mkdirSync(join(fixture.ctx.data_dir, "lease/held"), {recursive: true});
  let now = new Date().toISOString();
  const lease = new WriterLease(fixture.ctx.data_dir, {clock: () => now});
  try {
    expect(() => lease.tryAcquire("early")).toThrow();
    now = "2099-01-01T00:00:00.000Z";
    expect(lease.tryAcquire("later").action).toBe("reclaimed");
  } finally { lease.release(); fixture.cleanup(); }
});
