import { expect, test, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openEmbeddedRetrievalPort } from "../src/port";
import { OwnedDirectory } from "../../core/src/util/owned-directory";
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
    await expect(openEmbeddedRetrievalPort(f.ctx)).rejects.toThrow("heartbeat is still fresh");
    const reopened = await openEmbeddedRetrievalPort({ ...f.ctx, clock: () => new Date(Date.parse(f.ctx.clock()) + 120_002).toISOString() });
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
  const fault = spyOn(SqlStore.prototype, "close").mockImplementation(async function(this: SqlStore, disposeAssets = true) { entered(); await blocked; await original.call(this, disposeAssets); });
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
  const original = OwnedDirectory.prototype.removeTree;
  let injected = false;
  const fault = spyOn(OwnedDirectory.prototype, "removeTree").mockImplementation(function(this: OwnedDirectory, ...args: Parameters<OwnedDirectory["removeTree"]>) {
    const sync = fs.fsyncSync;
    const failure = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (!injected) { injected = true; throw Object.assign(new Error("synthetic deletion failure"), { code: "EACCES" }); }
      return sync(fd);
    });
    try { return original.apply(this, args); } finally { failure.mockRestore(); }
  });
  try {
    await expect(port.eraseOwnedGeneration()).rejects.toThrow("synthetic deletion failure");
    expect(injected).toBe(true);
    fault.mockRestore();
    // No SQL open is needed to finish the already-authorized whole-generation purge.
    const script = join(f.root, "retry.ts");
    writeFileSync(script, `import { eraseOwnedEmbeddedGeneration } from ${JSON.stringify(join(import.meta.dir, "../src/port.ts"))}; await eraseOwnedEmbeddedGeneration({...${JSON.stringify(f.ctx)},clock:()=>${JSON.stringify(new Date(Date.parse(f.ctx.clock()) + 60_001).toISOString())},logger:()=>{},secrets:async()=>''});`);
    const retried = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    expect(retried.exitCode, retried.stderr.toString()).toBe(0);
    expect(existsSync(join(f.ctx.data_dir, "store"))).toBe(false);
    const reopened = await openEmbeddedRetrievalPort({ ...f.ctx, clock: () => new Date(Date.parse(f.ctx.clock()) + 120_002).toISOString() });
    try { expect((await reopened.search(SYNTHETIC_QUERY)).hits).toEqual([]); }
    finally { await reopened.close(); }
  } finally { fault.mockRestore(); await port.close().catch(() => {}); f.cleanup(); }
});


test("unconfirmed SQL shutdown retains ownership until process death", async () => {
  const f = temporaryPortContext();
  const script = join(f.root, "shutdown-failure.ts");
  writeFileSync(script, `import { openEmbeddedRetrievalPort } from ${JSON.stringify(join(import.meta.dir, "../src/port.ts"))};
import { SqlStore } from ${JSON.stringify(join(import.meta.dir, "../src/sql-store.ts"))};
const ctx={...${JSON.stringify(f.ctx)},clock:()=>new Date().toISOString(),logger:()=>{},secrets:async()=>''};
const port=await openEmbeddedRetrievalPort(ctx);
SqlStore.prototype.close=async()=>{throw new Error('synthetic SQL shutdown failure')};
try { await port.eraseOwnedGeneration(); process.exit(2); } catch {}
try { await openEmbeddedRetrievalPort(ctx); process.exit(3); } catch(error) { if(!String(error).includes('writer lease')) process.exit(4); }
console.log('shutdown-unconfirmed-lease-retained'); process.exit(0);`);
  try {
    const child = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString()).toContain("shutdown-unconfirmed-lease-retained");
    expect(existsSync(join(f.ctx.data_dir, "store"))).toBe(true);
    const { eraseOwnedEmbeddedGeneration } = await import("../src/port");
    // Preserve the existing bounded stale-heartbeat policy after abrupt death.
    await expect(eraseOwnedEmbeddedGeneration(f.ctx)).rejects.toThrow("heartbeat is still fresh");
    await eraseOwnedEmbeddedGeneration({ ...f.ctx, clock: () => new Date(Date.now() + 60_001).toISOString() });
    expect(existsSync(join(f.ctx.data_dir, "store"))).toBe(false);
  } finally { f.cleanup(); }
}, 15_000);
