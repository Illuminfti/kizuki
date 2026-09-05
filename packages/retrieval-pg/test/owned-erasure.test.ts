import { expect, test, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openEmbeddedRetrievalPort } from "../src/port";
import { SqlStore } from "../src/sql-store";
import { temporaryPortContext, SYNTHETIC_DOCS, SYNTHETIC_QUERY, FixtureEmbeddingPort, hashVector } from "./helpers";

function contains(path: string, marker: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (stat.isDirectory()) return readdirSync(path).some(name => contains(join(path, name), marker));
  return stat.isFile() && readFileSync(path).includes(Buffer.from(marker));
}

test("native maintenance removes dead SQL bytes and legacy payloads, seals the old port, and reopens empty", async () => {
  const f = temporaryPortContext();
  const port = await openEmbeddedRetrievalPort(f.ctx);
  const marker = "SYNTHETIC_ERASURE_CANARY_6913";
  try {
    const doc = { ...SYNTHETIC_DOCS[0]!, text: marker };
    await port.upsert([doc]);
    await port.remove([doc.doc_id]);
    expect((await port.verifyAbsent([doc.doc_id])).found).toEqual([]);
    expect(contains(join(f.ctx.data_dir, "store"), marker)).toBe(true);
    writeFileSync(join(f.ctx.data_dir, "store", "docs.json"), marker);
    await port.eraseOwnedGeneration();
    expect(existsSync(join(f.ctx.data_dir, "store"))).toBe(false);
    expect(contains(f.ctx.data_dir, marker)).toBe(false);
    await expect(port.upsert([doc])).rejects.toThrow("closed");
    const reopened = await openEmbeddedRetrievalPort(f.ctx);
    try { expect((await reopened.search(SYNTHETIC_QUERY)).hits).toEqual([]); }
    finally { await reopened.close(); }
  } finally { await port.close(); f.cleanup(); }
});

test("empty authoritative replacement clears a historical vector generation without a model", async () => {
  const f = temporaryPortContext();
  const original = await openEmbeddedRetrievalPort(f.ctx, { embedding: new FixtureEmbeddingPort() });
  await original.upsert([SYNTHETIC_DOCS[0]!]); await original.close();
  const port = await openEmbeddedRetrievalPort(f.ctx);
  try {
    await expect(port.rebuildFromDocuments([SYNTHETIC_DOCS[0]!])).rejects.toThrow("requires its embedding port");
    await port.rebuildFromDocuments([]);
    expect((await port.verifyAbsent([SYNTHETIC_DOCS[0]!.doc_id])).found).toEqual([]);
    await port.eraseOwnedGeneration();
  } finally { await port.close(); f.cleanup(); }
});

test("a late embedding cannot resurrect an erased generation", async () => {
  const f = temporaryPortContext(); const embedding = new FixtureEmbeddingPort();
  let release!: () => void; let entered!: () => void;
  const blocked = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  embedding.embedDocs = async chunks => { entered(); await blocked; return chunks.map(c => hashVector(c.text)); };
  const port = await openEmbeddedRetrievalPort(f.ctx, { embedding });
  try {
    const work = port.upsert([SYNTHETIC_DOCS[0]!]); await started;
    await port.eraseOwnedGeneration(); release(); await work;
    expect(existsSync(join(f.ctx.data_dir, "store"))).toBe(false);
  } finally { release(); await port.close(); f.cleanup(); }
});

test("confirmed SQL shutdown precedes erasure and the lease covers concurrent close", async () => {
  const f = temporaryPortContext(); const port = await openEmbeddedRetrievalPort(f.ctx);
  const original = SqlStore.prototype.close;
  let release!: () => void; let entered!: () => void;
  const blocked = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  const fault = spyOn(SqlStore.prototype, "close").mockImplementation(async function(this: SqlStore) { entered(); await blocked; await original.call(this); });
  try {
    const erasing = port.eraseOwnedGeneration(); await started;
    const closing = port.close();
    await expect(openEmbeddedRetrievalPort(f.ctx)).rejects.toThrow("writer lease");
    expect(existsSync(join(f.ctx.data_dir, "store"))).toBe(true);
    release(); await Promise.all([erasing, closing]);
    expect(existsSync(join(f.ctx.data_dir, "store"))).toBe(false);
  } finally { release(); fault.mockRestore(); await port.close(); f.cleanup(); }
});

test("unknown files and symlink or hardlink generations stay untouched", async () => {
  const { linkSync, mkdirSync } = await import("node:fs");
  const { eraseOwnedEmbeddedGeneration } = await import("../src/port");
  const f = temporaryPortContext(); const port = await openEmbeddedRetrievalPort(f.ctx); await port.close();
  const outside = join(f.root, "outside"); mkdirSync(outside);
  const canary = join(outside, "canary"); writeFileSync(canary, "KEEP_SYNTHETIC_UNOWNED");
  try {
    const unknown = join(f.ctx.data_dir, "unknown.txt"); writeFileSync(unknown, "KEEP_UNKNOWN");
    await expect(eraseOwnedEmbeddedGeneration(f.ctx)).rejects.toThrow("unsafe");
    expect(readFileSync(unknown, "utf8")).toBe("KEEP_UNKNOWN"); unlinkSync(unknown);
    const alias = join(f.ctx.data_dir, "store", "graph.json"); symlinkSync(canary, alias);
    await expect(eraseOwnedEmbeddedGeneration(f.ctx)).rejects.toThrow("unsafe"); unlinkSync(alias);
    linkSync(canary, alias);
    await expect(eraseOwnedEmbeddedGeneration(f.ctx)).rejects.toThrow("unsafe"); unlinkSync(alias);
    expect(readFileSync(canary, "utf8")).toBe("KEEP_SYNTHETIC_UNOWNED");
    await eraseOwnedEmbeddedGeneration(f.ctx);
  } finally { f.cleanup(); }
});

test("failed partial deletion retries natively without reopening broken SQL", async () => {
  const fs = await import("node:fs");
  const { eraseOwnedEmbeddedGeneration } = await import("../src/port");
  const f = temporaryPortContext(); const port = await openEmbeddedRetrievalPort(f.ctx);
  await port.upsert([SYNTHETIC_DOCS[0]!]);
  const original = fs.rmSync;
  let injected = false;
  const fault = spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (String(path) === join(f.ctx.data_dir, "store") && !injected) {
      injected = true;
      original(join(f.ctx.data_dir, "store", "pgdata", "global"), { recursive: true, force: true });
      throw Object.assign(new Error("synthetic deletion failure"), { code: "EACCES" });
    }
    return original(path, options);
  });
  try {
    await expect(port.eraseOwnedGeneration()).rejects.toThrow("synthetic deletion failure");
    expect(injected).toBe(true);
    fault.mockRestore();
    // No SQL open is needed to finish the already-authorized whole-generation purge.
    await eraseOwnedEmbeddedGeneration(f.ctx);
    expect(existsSync(join(f.ctx.data_dir, "store"))).toBe(false);
    const reopened = await openEmbeddedRetrievalPort(f.ctx);
    try { expect((await reopened.search(SYNTHETIC_QUERY)).hits).toEqual([]); }
    finally { await reopened.close(); }
  } finally { fault.mockRestore(); await port.close().catch(() => {}); f.cleanup(); }
});
