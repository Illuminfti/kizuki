import { expect, setDefaultTimeout, test } from "bun:test";
import { PortError } from "@kizuki/core";
import { openEmbeddedRetrievalPort } from "../src/index";
import { SqlStore } from "../src/sql-store";
import { FixtureEmbeddingPort, FIXTURE_SPACE, SYNTHETIC_DOCS, SYNTHETIC_QUERY, temporaryPortContext } from "./helpers";
setDefaultTimeout(60_000);
const docs = Array.from({ length: 10 }, (_, i) => ({ ...SYNTHETIC_DOCS[0]!, doc_id: `page:resume-${i}`, title: `Grace ${i}`, text: `Grace synthetic resume record ${i}.`, provenance: [`event:resume-${i}`] }));
async function stage(f: ReturnType<typeof temporaryPortContext>) {
  const embedding = new FixtureEmbeddingPort();
  const port = await openEmbeddedRetrievalPort(f.ctx, { embedding });
  await port.rebuildFromDocuments([SYNTHETIC_DOCS[1]!]);
  embedding.failAfter = embedding.calls + 8;
  await expect(port.rebuildFromDocuments(docs)).rejects.toThrow("embedder killed");
  expect((await port.search(SYNTHETIC_QUERY)).hits.map(hit => hit.doc_id)).toEqual(["claim:grace-email"]);
  await port.close();
}
async function counts(f: ReturnType<typeof temporaryPortContext>) {
  const store = await SqlStore.open(f.ctx.data_dir);
  try { return (await store.db.query<{docs: number; vectors: number}>("SELECT (SELECT count(*)::int FROM rebuild_docs) AS docs,(SELECT count(*)::int FROM rebuild_vectors) AS vectors")).rows[0]!; }
  finally { await store.close(); }
}
test("interrupted work resumes after reopen and activates only a complete generation", async () => {
  const f = temporaryPortContext();
  try {
    await stage(f);
    expect(await counts(f)).toEqual({ docs: 10, vectors: 8 });
    const embedding = new FixtureEmbeddingPort();
    const reopened = await openEmbeddedRetrievalPort(f.ctx, { embedding });
    try {
      await reopened.rebuildFromDocuments([...docs].reverse());
      expect(embedding.calls).toBe(2);
      expect((await reopened.search({ ...SYNTHETIC_QUERY, mode: "vector" })).hits).toHaveLength(10);
      expect((await reopened.verifyAbsent(["claim:grace-email"])).found).toEqual([]);
    } finally { await reopened.close(); }
    expect(await counts(f)).toEqual({ docs: 0, vectors: 0 });
  } finally { f.cleanup(); }
});
for (const change of ["text", "provenance", "space", "chunking", "policy"] as const) {
  test(`changed ${change} invalidates every staged vector before reuse`, async () => {
    const f = temporaryPortContext();
    try {
      await stage(f);
      const embedding = new FixtureEmbeddingPort(change === "space" ? { ...FIXTURE_SPACE, id: "fixture:next@8" } : FIXTURE_SPACE);
      const reopened = await openEmbeddedRetrievalPort(f.ctx, { embedding, ...(change === "chunking" ? { chunk_tokens: 9 } : {}) });
      try {
        const changed = docs.map((doc, i) => i !== 0 ? doc : { ...doc,
          ...(change === "text" ? { text: "Grace changed current record." } : {}),
          ...(change === "provenance" ? { provenance: ["event:replacement"] } : {}) });
        await reopened.rebuildFromDocuments(changed, change === "policy" ? { snapshot_id: "new-authorized-policy-epoch" } : {});
        expect(embedding.calls).toBe(10);
      } finally { await reopened.close(); }
    } finally { f.cleanup(); }
  });
}
for (const byProvenance of [false, true]) {
  test(`erasure includes private staging (${byProvenance ? "provenance" : "document"})`, async () => {
    const f = temporaryPortContext();
    try {
      await stage(f);
      const reopened = await openEmbeddedRetrievalPort(f.ctx, { embedding: new FixtureEmbeddingPort() });
      try {
        const ids = [byProvenance ? "resume-0" : "page:resume-0"];
        expect((await (byProvenance ? reopened.verifyProvenanceAbsent(ids) : reopened.verifyAbsent(ids))).found).toEqual(ids);
        await (byProvenance ? reopened.removeByProvenance(ids) : reopened.remove(ids));
        expect((await (byProvenance ? reopened.verifyProvenanceAbsent(ids) : reopened.verifyAbsent(ids))).found).toEqual([]);
      } finally { await reopened.close(); }
      expect(await counts(f)).toEqual({ docs: 9, vectors: 7 });
      const again = await openEmbeddedRetrievalPort(f.ctx, { embedding: new FixtureEmbeddingPort() });
      await again.eraseOwnedGeneration();
      expect(await counts(f)).toEqual({ docs: 0, vectors: 0 });
    } finally { f.cleanup(); }
  });
}
test("final authority rejection rolls activation back and cancellation resumes only completed batches", async () => {
  const f = temporaryPortContext();
  const embedding = new FixtureEmbeddingPort();
  const port = await openEmbeddedRetrievalPort(f.ctx, { embedding });
  try {
    await port.rebuildFromDocuments([SYNTHETIC_DOCS[1]!]);
    let checks = 0;
    await expect(port.rebuildFromDocuments(docs, { assertCurrent: () => {
      if (++checks === 2) throw new PortError("unavailable", "synthetic authority changed", true);
    } })).rejects.toThrow("synthetic authority changed");
    expect(checks).toBe(2);
    expect((await port.search(SYNTHETIC_QUERY)).hits.map(hit => hit.doc_id)).toEqual(["claim:grace-email"]);
    await port.remove(docs.map(doc => doc.doc_id));
    const stop = new AbortController();
    const original = embedding.embedDocs.bind(embedding);
    let batches = 0;
    embedding.embedDocs = async chunks => {
      if (++batches === 2) { stop.abort(); return new Promise(() => {}); }
      return original(chunks);
    };
    await expect(port.rebuildFromDocuments(docs, { signal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect((await port.search(SYNTHETIC_QUERY)).hits.map(hit => hit.doc_id)).toEqual(["claim:grace-email"]);
    const before = embedding.calls;
    embedding.embedDocs = original;
    await port.rebuildFromDocuments(docs);
    expect(embedding.calls - before).toBe(8);
  } finally { await port.close(); f.cleanup(); }
});
