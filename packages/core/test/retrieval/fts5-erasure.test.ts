import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fts from "../../src/retrieval/fts5";
import type { PortContext } from "../../src/contracts/ports";
import { SYNTHETIC_DOCS } from "../contracts/fixtures";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): PortContext {
  const root = mkdtempSync(join(tmpdir(), "fts-erasure-")); roots.push(root);
  return { vault_path: root, data_dir: join(root, ".kizuki/retrieval", fts.FTS5_RETRIEVAL_ID), config: {}, clock: () => new Date().toISOString(), logger: () => {}, secrets: async () => { throw new Error("unused"); } };
}
test("derived SQLite generation erases physically, seals retained port, and preserves ledger bytes", async () => {
  const ctx = fixture();
  const ledger = join(ctx.vault_path, "kizuki.db"); writeFileSync(ledger, "authoritative-synthetic-ledger");
  const port = fts.createFts5RetrievalPort(ctx);
  await port.upsert(SYNTHETIC_DOCS);
  await port.eraseOwnedGeneration();
  expect(existsSync(join(ctx.data_dir, "store"))).toBe(false);
  expect(readFileSync(ledger, "utf8")).toBe("authoritative-synthetic-ledger");
  await expect(port.upsert(SYNTHETIC_DOCS)).rejects.toThrow("closed");
  const reopened = fts.createFts5RetrievalPort(ctx);
  expect(await reopened.health()).toMatchObject({ status: "ready", detail: { documents: 0 } }); await reopened.close();
});
test("every native FTS instance holds a lifetime lock and SQL-free recovery removes a broken generation", async () => {
  const ctx = fixture(); const port = fts.createFts5RetrievalPort(ctx);
  expect(() => fts.createFts5RetrievalPort(ctx)).toThrow("busy");
  await expect(fts.eraseOwnedFts5Generation(ctx)).rejects.toThrow("busy");
  await port.close();
  writeFileSync(join(ctx.data_dir, "store/retrieval.db"), "broken-synthetic-private-db");
  await fts.eraseOwnedFts5Generation(ctx);
  expect(existsSync(join(ctx.data_dir, "store"))).toBe(false);
});
test("retained asynchronous rebuild cannot resurrect an erased generation", async () => {
  const ctx = fixture(); const port = fts.createFts5RetrievalPort(ctx);
  let resume!: () => void; const wait = new Promise<void>(r => { resume = r; });
  const rebuilding = port.rebuildFromDocuments((async function* () { await wait; yield SYNTHETIC_DOCS[0]!; })());
  await port.eraseOwnedGeneration(); resume();
  await expect(rebuilding).rejects.toThrow("closed");
  expect(existsSync(join(ctx.data_dir, "store"))).toBe(false);
});
test("unknown files and symlinked roots remain untouched", async () => {
  const ctx = fixture(); const port = fts.createFts5RetrievalPort(ctx);
  writeFileSync(join(ctx.data_dir, "store/unknown"), "preserve");
  await expect(port.eraseOwnedGeneration()).rejects.toThrow("unsafe");
  expect(readFileSync(join(ctx.data_dir, "store/unknown"), "utf8")).toBe("preserve");
  await port.close(); rmSync(join(ctx.data_dir, "store/unknown"));
  const target = join(ctx.vault_path, "separate"); mkdirSync(target);
  symlinkSync(target, join(ctx.data_dir, "store/link"));
  await expect(fts.eraseOwnedFts5Generation(ctx)).rejects.toThrow("unsafe");
  expect(existsSync(target)).toBe(true);
});
test("pinned SQLite reader refuses erasure until it releases its snapshot", async () => {
  const ctx = fixture(); const port = fts.createFts5RetrievalPort(ctx);
  await port.upsert(SYNTHETIC_DOCS);
  const reader = new Database(join(ctx.data_dir, "store/retrieval.db"), { readonly: true });
  try {
    reader.exec("BEGIN"); reader.query("SELECT * FROM search_documents").all();
    await port.remove([SYNTHETIC_DOCS[0]!.doc_id]);
    await expect(port.eraseOwnedGeneration()).rejects.toThrow("active readers");
    expect(existsSync(join(ctx.data_dir, "store/retrieval.db"))).toBe(true);
    reader.exec("ROLLBACK"); await port.eraseOwnedGeneration();
    expect(existsSync(join(ctx.data_dir, "store"))).toBe(false);
  } finally { reader.close(); await port.close(); }
});
test("process death releases native ownership for SQL-free cleanup", async () => {
  const ctx = fixture();
  const script = join(ctx.vault_path, "holder.ts");
  writeFileSync(script, `import { createFts5RetrievalPort } from ${JSON.stringify(join(import.meta.dir, "../../src/retrieval/fts5.ts"))};\ncreateFts5RetrievalPort({...${JSON.stringify(ctx)}, clock:()=>new Date().toISOString(),logger:()=>{},secrets:async()=>''});\nconsole.log('ready'); setInterval(()=>{},1000);`);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  try {
    const stream = child.stdout.getReader(); expect(new TextDecoder().decode((await stream.read()).value)).toContain("ready"); stream.releaseLock();
    await expect(fts.eraseOwnedFts5Generation(ctx)).rejects.toThrow("busy");
    child.kill("SIGKILL"); await child.exited;
    await fts.eraseOwnedFts5Generation(ctx);
    expect(existsSync(join(ctx.data_dir, "store"))).toBe(false);
  } finally { child.kill(); await child.exited; }
});
