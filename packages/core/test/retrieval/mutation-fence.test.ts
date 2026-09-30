import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFts5RetrievalPort, FTS5_RETRIEVAL_DESCRIPTOR } from "../../src/retrieval/fts5";
import { SYNTHETIC_DOCS, temporaryPortContext } from "../contracts/fixtures";

test("native fencing holds the exclusive generation through reconciliation and refuses after close", async () => {
  const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  const port = createFts5RetrievalPort(temporary.ctx);
  try {
    await port.upsert(SYNTHETIC_DOCS);
    expect(await port.fenceMutations()).toEqual({ store: port.descriptor.id });
    expect(() => createFts5RetrievalPort(temporary.ctx)).toThrow("busy");
    await port.upsert(SYNTHETIC_DOCS);
    await port.close();
    await expect(port.fenceMutations()).rejects.toThrow("closed");
  } finally { await port.close(); temporary.cleanup(); }
});

test("a pending rebuild continuation cannot pass the native fence", async () => {
  const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  const port = createFts5RetrievalPort(temporary.ctx);
  let resume!: () => void;
  const pending = new Promise<void>(resolve => { resume = resolve; });
  async function* documents() { await pending; yield* SYNTHETIC_DOCS; }
  const rebuilding = port.rebuildFromDocuments(documents());
  try {
    await expect(port.fenceMutations()).rejects.toThrow("rebuild is in progress");
    resume(); await rebuilding;
    expect(await port.fenceMutations()).toEqual({ store: port.descriptor.id });
  } finally { resume(); await rebuilding; await port.close(); temporary.cleanup(); }
});

test("a native mutation rechecks custody inside its SQL transaction after validating input", async () => {
  const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  const port = createFts5RetrievalPort(temporary.ctx);
  try {
    const doc = { ...SYNTHETIC_DOCS[0]! };
    Object.defineProperty(doc, "title", { get() {
      const lock = join(temporary.ctx.data_dir, "writer.lock");
      rmSync(lock); writeFileSync(lock, "", { mode: 0o600 });
      return SYNTHETIC_DOCS[0]!.title;
    } });
    await expect(port.upsert([doc])).rejects.toThrow("custody changed");
    expect((await port.verifyAbsent([doc.doc_id])).found).toEqual([]);
  } finally { await port.close(); temporary.cleanup(); }
});

for (const target of ["writer.lock", "store", "root"] as const) {
  test(`native fencing and retained mutations refuse a replaced ${target}`, async () => {
    const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
    const port = createFts5RetrievalPort(temporary.ctx);
    try {
      if (target === "writer.lock") {
        rmSync(join(temporary.ctx.data_dir, target));
        writeFileSync(join(temporary.ctx.data_dir, target), "", { mode: 0o600 });
      } else {
        const path = target === "root" ? temporary.ctx.data_dir : join(temporary.ctx.data_dir, target);
        renameSync(path, `${path}.moved`); mkdirSync(path, { mode: 0o700 });
      }
      await expect(port.fenceMutations()).rejects.toThrow("custody changed");
      await expect(port.upsert(SYNTHETIC_DOCS)).rejects.toThrow("custody changed");
      await expect(port.remove([SYNTHETIC_DOCS[0]!.doc_id])).rejects.toThrow("custody changed");
    } finally { await port.close(); temporary.cleanup(); }
  });
}

test("a minor-zero native store opens and upgrades its engine manifest without a ledger migration", async () => {
  const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  const path = join(temporary.ctx.data_dir, "engine.json");
  const first = createFts5RetrievalPort(temporary.ctx);
  await first.upsert(SYNTHETIC_DOCS); await first.close();
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...manifest, contract_minor: 0 }), { mode: 0o600 });
  const reopened = createFts5RetrievalPort(temporary.ctx);
  try {
    expect(JSON.parse(readFileSync(path, "utf8")).contract_minor).toBe(1);
    expect(await reopened.fenceMutations()).toEqual({ store: reopened.descriptor.id });
    expect((await reopened.verifyAbsent(SYNTHETIC_DOCS.map(doc => doc.doc_id))).found).toHaveLength(SYNTHETIC_DOCS.length);
  } finally { await reopened.close(); temporary.cleanup(); }
});
