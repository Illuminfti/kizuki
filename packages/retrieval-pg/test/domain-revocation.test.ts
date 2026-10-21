import { expect,test } from "bun:test";
import { join } from "node:path";
import { serveFixture } from "../../core/test/serving/helpers";
import { enrollSource } from "../../core/test/helpers/world-seed";
import { accept } from "../../core/src/ledger/ledger";
import { bindLocalSourcePort,revokeSourceGrant } from "../../core/src/ledger/source-grants";
import { readRetrievalDocuments } from "../../core/src/retrieval/rebuild";
import { serveSearch } from "../../core/src/serving/search";
import { openEmbeddedRetrievalPort } from "../src/port";
import { FixtureEmbeddingPort } from "./helpers";

test("v2 revoke during query cannot publish backlog diagnostics from the now-denied source",async()=>{
  const f=await serveFixture({held:false});const embedding=new FixtureEmbeddingPort();
  let engine:Awaited<ReturnType<typeof openEmbeddedRetrievalPort>>|undefined;
  try{
    const healthy=enrollSource(f.db,"domain","public"),revoked=enrollSource(f.db,"domain","public");
    const record=(source:string,name:string)=>{
      const r=accept(f.db,{schema:"kizuki.event/v1",connector_id:"domain",source_record_id:name,kind:"message",occurred_at:"2026-02-28T10:00:00Z",observed_at:"2026-03-01T00:00:00Z",text:`The ${name} kettle keeps water warm.`,subjects:[{subject_id:"person:ada",role:"about"}],sensitivity_hint:"public",deleted:false,attachments:[],metadata:{}},{source:{source_key:source,expected_revision:1}});
      if(r.status!=="stored")throw Error("capture failed");return r.event.event_id;
    };
    const healthyId=record(healthy,"healthy"),pendingId=record(revoked,"pending");
    const docs=readRetrievalDocuments(f.db,f.vaultPath),pending=docs.find(d=>d.doc_id===`event:${pendingId}`)!;
    expect(pending).toBeDefined();
    engine=await openEmbeddedRetrievalPort({vault_path:f.vaultPath,data_dir:join(f.vaultPath,".kizuki/retrieval/kizuki.retrieval.embedded-pg"),config:{},secrets:async()=>{throw Error("no secret")},clock:()=>new Date().toISOString(),logger:()=>{}},{embedding});
    bindLocalSourcePort(engine,{store_id:"local:kizuki.retrieval.embedded-pg"});
    await engine.upsert(docs.filter(d=>d.doc_id!==pending.doc_id));
    embedding.failAfter=embedding.calls;
    await expect(engine.upsert([pending])).rejects.toMatchObject({code:"unavailable"});
    embedding.failAfter=null;
    const original=embedding.embedQuery.bind(embedding);let changed=false;
    embedding.embedQuery=async texts=>{
      const answer=await original(texts);
      if(!changed){changed=true;revokeSourceGrant(f.db,{source_key:revoked,expected_revision:1,operation_id:"independent-race-revoke"});}
      return answer;
    };
    const ctx={...f.agent("reader-personal"),retrieval:engine};
    await expect(serveSearch(ctx,{query:"kettle",scope:"ledger"},"kizuki.envelope/v2"))
      .rejects.toMatchObject({code:"error",message:"authorized evidence changed during request; retry"});
    const current=await serveSearch(ctx,{query:"kettle",scope:"ledger"},"kizuki.envelope/v2");
    expect(changed).toBe(true);
    expect(current.quoted.map(row=>row.event_id)).toContain(healthyId);
    expect(current.quoted.map(row=>row.event_id)).not.toContain(pendingId);
    expect(current.data?.degraded??[]).not.toContain("retrieval-vector-partial");
  }finally{await engine?.close();f.dispose();}
},120000);
