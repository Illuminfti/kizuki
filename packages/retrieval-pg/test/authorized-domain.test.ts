import {test,expect} from "bun:test";
import {join} from "node:path";
import {serveFixture} from "../../core/test/serving/helpers";
import {serveSearch} from "../../core/src/serving/search";
import {accept} from "../../core/src/ledger/ledger";
import {setGrant} from "../../core/src/agents";
import {bindLocalSourcePort} from "../../core/src/ledger/source-grants";
import {readRetrievalDocuments} from "../../core/src/retrieval/rebuild";
import {openEmbeddedRetrievalPort} from "../src/port";
import {FixtureEmbeddingPort} from "./helpers";

test("class-denied backlog cannot change scoped public hybrid diagnostics",async()=>{
 const f=await serveFixture({held:false});let engine:Awaited<ReturnType<typeof openEmbeddedRetrievalPort>>|undefined;
 try{
  setGrant(f.db,"reader-personal",{deny_classes:["credential"]});
  const captured=accept(f.db,{schema:"kizuki.event/v1",connector_id:"fixture",source_record_id:"hidden-embedding-class",kind:"message",occurred_at:"2026-02-28T10:15:00Z",observed_at:"2026-03-01T00:00:00Z",text:"Synthetic password=fictional-needle-7788 kettle",subjects:[{subject_id:"person:ada",role:"from"}],sensitivity_hint:"public",deleted:false,attachments:[],metadata:{}});
  expect(captured.status).toBe("stored"); if(captured.status!=="stored")throw Error("capture refused");
  const id=captured.event.event_id;
  expect(f.db.query("SELECT 1 FROM event_classes WHERE event_id=? AND class='credential'").get(id)).not.toBeNull();
  const docs=readRetrievalDocuments(f.db,f.vaultPath),hidden=docs.find(d=>d.doc_id===`event:${id}`)!;expect(hidden).toBeDefined();
  const embedding=new FixtureEmbeddingPort();
  engine=await openEmbeddedRetrievalPort({vault_path:f.vaultPath,data_dir:join(f.vaultPath,".kizuki/retrieval/kizuki.retrieval.embedded-pg"),config:{},secrets:async()=>{throw Error("no secret")},clock:()=>new Date().toISOString(),logger:()=>{}},{embedding});
  bindLocalSourcePort(engine,{store_id:"local:kizuki.retrieval.embedded-pg"});
  await engine.upsert(docs.filter(d=>d.doc_id!==hidden.doc_id));
  const ctx={...f.agent("reader-personal"),retrieval:engine};const args={query:"kettle",scope:"all" as const,limit:10};
  const before=await serveSearch(ctx,args);
  embedding.failAfter=embedding.calls;
  await expect(engine.upsert([hidden])).rejects.toMatchObject({code:"unavailable"});
  const after=await serveSearch(ctx,args);
  expect(after.canon).toEqual(before.canon);expect(after.quoted).toEqual(before.quoted);
  expect(after.data?.degraded??[]).toEqual(before.data?.degraded??[]);
 }finally{await engine?.close();f.dispose();}
},120000);

import { recordedPage, storeEvent } from "../../core/test/serving/helpers";
import { rebuildDerived } from "../../core/src/derived";
import { enrollSource } from "../../core/test/helpers/world-seed";
import { revokeSourceGrant } from "../../core/src/ledger/source-grants";
import { retrievalDocumentScope } from "../../core/src/contracts/retrieval";
import { SYNTHETIC_DOCS, SYNTHETIC_QUERY, temporaryPortContext } from "./helpers";

async function liveEngine(f: Awaited<ReturnType<typeof serveFixture>>, embedding = new FixtureEmbeddingPort()) {
  const port = await openEmbeddedRetrievalPort({ vault_path: f.vaultPath,
    data_dir: join(f.vaultPath, ".kizuki/retrieval/kizuki.retrieval.embedded-pg"), config: {},
    secrets: async () => { throw Error("no secret"); }, clock: () => new Date().toISOString(), logger: () => {} }, { embedding });
  return { port: bindLocalSourcePort(port, { store_id: "local:kizuki.retrieval.embedded-pg" }), embedding };
}
function boundCapture(f: Awaited<ReturnType<typeof serveFixture>>, source: string, id: string, text: string) {
  const result = accept(f.db, { schema: "kizuki.event/v1", connector_id: "domain", source_record_id: id,
    kind: "message", occurred_at: "2026-02-28T10:00:00Z", observed_at: "2026-03-01T00:00:00Z", text,
    subjects: [{ subject_id: "person:ada", role: "about" }], sensitivity_hint: "public", deleted: false, attachments: [], metadata: {} },
    { source: { source_key: source, expected_revision: 1 } });
  if (result.status !== "stored") throw Error("fixture capture refused");
  return result.event.event_id;
}

test("exact metadata and content fingerprints exclude stale same-ID vectors before ranking and diagnostics", async () => {
  const f = temporaryPortContext(), embedding = new FixtureEmbeddingPort();
  const port = await openEmbeddedRetrievalPort(f.ctx, { embedding });
  const doc = SYNTHETIC_DOCS[0]!;
  try {
    await port.upsert([doc]);
    const ask = (current: typeof doc) => port.search({ ...SYNTHETIC_QUERY, mode: "hybrid", scope: { documents: [retrievalDocumentScope(current)] } });
    expect((await ask(doc)).hits.map(hit => hit.doc_id)).toEqual([doc.doc_id]);
    for (const changed of [{ ...doc, text: "A corrected unrelated assertion." }, { ...doc, title: "A changed title" },
      { ...doc, provenance: ["event:different-root"] }, { ...doc, authority: "owner_correction" as const }]) {
      const answer = await ask(changed);
      expect(answer.hits).toEqual([]);
      expect(answer.degraded).not.toContain("vector-backlog");
      expect(answer.degraded).not.toContain("embedding-space-mismatch");
    }
  } finally { await port.close(); f.cleanup(); }
}, 120000);

test("source-denied indexed prefixes and pending vectors cannot change visible ranking or diagnostics", async () => {
  const f = await serveFixture({ held: false }); const { port, embedding } = await liveEngine(f);
  try {
    const allowed = enrollSource(f.db, "domain", "public");
    const denied = enrollSource(f.db, "domain", "public", undefined, undefined, ["capture", "derive"]);
    const visibleId = boundCapture(f, allowed, "visible", "A kettle keeps water warm.");
    const deniedId = boundCapture(f, denied, "denied", "A kettle keeps water warm and boils tea.");
    rebuildDerived(f.db, f.vaultPath);
    const docs = readRetrievalDocuments(f.db, f.vaultPath), hidden = docs.find(doc => doc.doc_id === `event:${deniedId}`)!;
    expect(hidden).toBeDefined();
    await port.upsert(docs.filter(doc => doc.doc_id !== hidden.doc_id));
    const ctx = { ...f.agent("reader-personal"), retrieval: port };
    const before = await serveSearch(ctx, { query: "teapot", scope: "ledger", limit: 1 });
    expect(before.quoted.map(row => row.event_id)).toEqual([visibleId]);
    embedding.failAfter = embedding.calls;
    await expect(port.upsert([hidden])).rejects.toMatchObject({ code: "unavailable" });
    const afterPending = await serveSearch(ctx, { query: "teapot", scope: "ledger", limit: 1 });
    expect(afterPending.quoted).toEqual(before.quoted); expect(afterPending.data).toEqual(before.data);
    embedding.failAfter = null; await port.embedPending();
    const afterRanked = await serveSearch(ctx, { query: "teapot", scope: "ledger", limit: 1 });
    expect(afterRanked.quoted).toEqual(before.quoted); expect(afterRanked.data).toEqual(before.data);
  } finally { await port.close(); f.dispose(); }
}, 120000);

test("semantic nominations cannot recover redacted secrets or withheld tails", async () => {
  const f = await serveFixture({ held: false }); const { port } = await liveEngine(f);
  try {
    setGrant(f.db, "reader-personal", { deny_classes: [] });
    const secret = storeEvent(f.db, "semantic-secret", "2026-02-28T10:00:00Z", "wifi password=fictional-needle-7788 is on the fridge", "person:ada", "public");
    const tail = storeEvent(f.db, "semantic-tail", "2026-02-28T10:00:00Z", "The safe note is here, and the water is warm. ".repeat(20) + "hidden-tail-needle", "person:ada", "public");
    rebuildDerived(f.db, f.vaultPath); await port.rebuildFromDocuments(readRetrievalDocuments(f.db, f.vaultPath));
    const ctx = { ...f.agent("reader-personal"), retrieval: port };
    const visible = await serveSearch(ctx, { query: "wifi", scope: "ledger" });
    expect(visible.quoted.some(row => row.event_id === secret)).toBe(true);
    expect(JSON.stringify(visible)).not.toContain("fictional-needle-7788");
    for (const query of ["fictional-needle-7788", '"password fictional*"', "hidden-tail-needle"]) {
      const answer = await serveSearch(ctx, { query, scope: "ledger" });
      expect(answer.quoted.map(row => row.event_id)).not.toContain(secret);
      expect(answer.quoted.map(row => row.event_id)).not.toContain(tail);
    }
  } finally { await port.close(); f.dispose(); }
}, 120000);

test("a same-ID receipted revision during an embedding await cannot inherit semantic permission", async () => {
  const f = await serveFixture({ held: false }); const { port, embedding } = await liveEngine(f);
  try {
    await port.rebuildFromDocuments(readRetrievalDocuments(f.db, f.vaultPath));
    const original = embedding.embedQuery.bind(embedding);
    let changed = false;
    embedding.embedQuery = async texts => {
      const vectors = await original(texts);
      if (!changed) { changed = true; await recordedPage(f.db, f.vaultPath, "entities/person-ada.md", {
        id: "person:ada", title: "Ada", type: "person", status: "active", sensitivity: "public", taint: "clean", subjects: ["person:ada"],
      }, "Ada now documents orchid cultivation."); }
      return vectors;
    };
    await expect(serveSearch({ ...f.agent("reader-personal"), retrieval: port }, { query: "teapot", scope: "canon" }))
      .rejects.toMatchObject({ code: "held", message: "canon changed during request; retry" });
    expect(changed).toBe(true);
  } finally { await port.close(); f.dispose(); }
}, 120000);

test("source revocation during the actual query embedding await refuses final publication", async () => {
  const f = await serveFixture({ held: false }); const { port, embedding } = await liveEngine(f);
  try {
    const source = enrollSource(f.db, "domain", "public");
    boundCapture(f, source, "will-revoke", "A kettle keeps water warm.");
    rebuildDerived(f.db, f.vaultPath); await port.rebuildFromDocuments(readRetrievalDocuments(f.db, f.vaultPath));
    const original = embedding.embedQuery.bind(embedding);
    embedding.embedQuery = async texts => { const vectors = await original(texts);
      revokeSourceGrant(f.db, { source_key: source, expected_revision: 1, operation_id: "embedding-await-revoke" }); return vectors; };
    await expect(serveSearch({ ...f.agent("reader-personal"), retrieval: port }, { query: "teapot", scope: "ledger" }))
      .rejects.toMatchObject({ code: "error", message: "source authorization changed during request; retry" });
  } finally { await port.close(); f.dispose(); }
}, 120000);
