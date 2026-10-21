import { accept } from "../../src/ledger/ledger";
import { expect, test } from "bun:test";
import { serveFixture, recordedPage } from "./helpers";
import { serveSearch } from "../../src/serving/search";
import { serveContextPacket } from "../../src/serving/packet";
import { bindLocalSourcePort } from "../../src/ledger/source-grants";
import { ReferenceRetrievalPort, DIRECT_RETRIEVAL_DESCRIPTOR } from "../contracts/reference-retrieval";
import { temporaryPortContext } from "../contracts/fixtures";

const descriptor={...DIRECT_RETRIEVAL_DESCRIPTOR,supports:["lexical","vector","hybrid","document-scope/v1"] as const};
function port(){
  const tmp=temporaryPortContext(descriptor);
  const engine=new ReferenceRetrievalPort(tmp.ctx,descriptor);
  bindLocalSourcePort(engine,{store_id:"local:test.semantic"});
  return {tmp,engine};
}
const result=(ids:string[])=>({hits:ids.map(doc_id=>({doc_id,kind:"page" as const,score:1,snippet:"",sensitivity:"public" as const,taint:"clean" as const,authority:"connector_evidence" as const})),degraded:[],timings_ms:{},space:null});

test("empty semantic result cannot turn every scoped subject page into a query match", async()=>{
  const f=await serveFixture({held:false});const {tmp,engine}=port();
  engine.search=async()=>result([]);
  try{
    const args={query:"teapot",subjects:["person:ada"],include:["canon" as const],budget_tokens:2000};
    const baseline=await serveContextPacket(f.agent("reader-personal"),args);
    expect(baseline.canon).toEqual([]);
    const current=await serveContextPacket({...f.agent("reader-personal"),retrieval:engine},args);
    expect(current.canon).toEqual(baseline.canon);
  } finally{f.dispose();tmp.cleanup();}
});

test.each(["owner","agent"] as const)("same-id native revision after query invalidates %s semantic nomination",async actor=>{
  const f=await serveFixture({held:false});const {tmp,engine}=port();
  engine.search=async query=>{
    expect(query.scope.documents?.some(row=>row.doc_id==="page:person:ada")).toBe(true);
    await recordedPage(f.db,f.vaultPath,"entities/person-ada.md",{sources:[f.events.public!],id:"person:ada",title:"Ada",type:"person",status:"active",sensitivity:"public",taint:"clean",subjects:["person:ada"],"x-handle":"ada-handle"},"Ada makes coffee.");
    return result(["page:person:ada"]);
  };
  try{
    const ctx=actor==="owner"?f.owner():f.agent("reader-personal");
    await expect(serveSearch({...ctx,retrieval:engine},{query:"teapot",scope:"canon"},"kizuki.envelope/v2"))
      .rejects.toMatchObject({code:"error",message:"authorized evidence changed during request; retry"});
    const positive=await serveSearch(ctx,{query:"coffee",scope:"canon"});
    expect(positive.canon.map(row=>row.page_id)).toContain("person:ada");
  } finally{f.dispose();tmp.cleanup();}
});


test("a credential-only mutation during query cannot alter the scoped hybrid answer", async()=>{
  const f=await serveFixture({held:false});const {tmp,engine}=port();
  try{
    engine.search=async()=>result(["page:person:ada"]);
    const ctx={...f.agent("reader-personal"),retrieval:engine};
    const before=await serveSearch(ctx,{query:"teapot",scope:"all"},"kizuki.envelope/v2");
    engine.search=async()=>{
      const captured=accept(f.db,{schema:"kizuki.event/v1",connector_id:"fixture",source_record_id:"hidden-midquery",kind:"message",occurred_at:"2026-02-28T10:15:00Z",observed_at:"2026-03-01T00:00:00Z",text:"Synthetic password=fictional-midquery-7788 kettle",subjects:[{subject_id:"person:ada",role:"from"}],sensitivity_hint:"public",deleted:false,attachments:[],metadata:{}});
      expect(captured.status).toBe("stored");
      return result(["page:person:ada"]);
    };
    const after=await serveSearch(ctx,{query:"teapot",scope:"all"},"kizuki.envelope/v2");
    expect(after.canon).toEqual(before.canon);expect(after.quoted).toEqual(before.quoted);expect(after.data).toEqual(before.data);
  } finally{f.dispose();tmp.cleanup();}
});
