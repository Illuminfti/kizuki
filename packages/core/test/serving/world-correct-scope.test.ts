import { expect, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT, setGrant } from "../../src/agents";
import { serveCorrect } from "../../src/serving/correct";
import { serveWorldView } from "../../src/serving/world-view";
import { getClaim } from "../../src/claims/store";
import { inspectSourceGrant, setSourceGrant, revokeSourceGrant } from "../../src/ledger/source-grants";
import { cardFixture } from "../world/card-fixture";
const WHEN={valid:{kind:"all"},knownAt:{kind:"current"}} as const;
async function scene(){
 const f=await cardFixture();
 for(const id of ["a","b","c","hidden"]){
  await f.write("world.kind",{kind:"vocabulary",ref:{kind:"vocabulary",id:"world/situation"}},{subject:`project:${id}`});
  await f.write("situation.label",{kind:"literal",value:`Project ${id}`},{subject:`project:${id}`});
 }
 const edge=await f.write("situation.requires",{kind:"subject",ref:f.ref("project:c")},{subject:"project:b"});
 if(edge.stored.outcome!=="stored")throw Error("edge missing");
 const agent=addAgent(f.db,"scoped-corrector",{...OWNER_AGENT_GRANT,subjects:["project:a","project:b","project:c"]});
 const ctx={...f.ctx,principal:authenticate(f.db,agent.token)!};
 const find=(id:string)=>{
  const out=serveWorldView(ctx,{operation:"find_situations",label:`Project ${id}`,...WHEN}).data;
  if(!("result"in out)||!("data"in out.result)||!("matches"in out.result.data))throw Error("no discovery");
  return out.result.data.matches[0]!.ref;
 };
 const b=find("b"), a=find("a");
 const read=()=>{
  const out=serveWorldView(ctx,{operation:"situation",situation:b,card:"kizuki.situation-card/v2",...WHEN}).data;
  if(!("result"in out)||!("data"in out.result)||out.result.data.schema!=="kizuki.situation-card/v2")throw Error("no card");
  return out.result.data;
 };
 const target=read().dependencies[0]!.relation.claim;
 const correct=()=>serveCorrect(ctx,{statement:"Project b depends on project a.",target:{world_claim:target},mode:"replace_object",object:{kind:"node",ref:a}});
 const counts=()=>["events","claims","native_owner_evidence"].map(t=>f.db.query<{n:number},[]>(`SELECT count(*) n FROM ${t}`).get()!.n);
 return {...f,ctx,read,correct,counts,target,replacement:a,old:edge.stored.claim.claim_id};
}
test("a subject-scoped relay corrects a readable typed relation through native evidence",async()=>{
 const f=await scene();try{
  expect(f.read().dependencies).toHaveLength(1);
  const out=await f.correct();
  expect(out.data?.claim_id).toBeString();
  expect(out.data?.superseded.map(item=>item.claim_id)).toEqual([f.old]);
  expect(getClaim(f.db,f.old)?.status).toBe("superseded");
  expect(f.read().dependencies).toHaveLength(1);
  expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM native_owner_evidence").get()!.n).toBe(1);
 }finally{f.dispose();}
},120000);
test("a hidden endpoint cannot turn a scoped correction into a cycle oracle",async()=>{
 const f=await scene();try{
  await f.write("situation.requires",{kind:"subject",ref:f.ref("project:hidden")},{subject:"project:a"});
  await f.write("situation.requires",{kind:"subject",ref:f.ref("project:b")},{subject:"project:hidden"});
  const out=await f.correct();
  expect(out.data?.claim_id).toBeString();
  expect(getClaim(f.db,f.old)?.status).toBe("superseded");
 }finally{f.dispose();}
},120000);
test("a readable replacement node also needs its source's correction purpose",async()=>{
 const f=await scene(), other=await cardFixture(f.db);try{
  await other.write("world.kind",{kind:"vocabulary",ref:{kind:"vocabulary",id:"world/situation"}},{subject:"project:a"});
  await other.write("situation.label",{kind:"literal",value:"Alternate A"},{subject:"project:a"});
  const grant=inspectSourceGrant(f.db,other.sourceKey)!;
  setSourceGrant(f.db,{source_key:other.sourceKey,expected_revision:grant.revision,operation_id:"deny-replacement-correction",policy:{...grant.policy,purposes:grant.policy.purposes.filter(p=>p!=="correction")}});
  const found=serveWorldView(f.ctx,{operation:"find_situations",label:"Alternate A",...WHEN}).data;
  if(!("result"in found)||!("data"in found.result)||!("matches"in found.result.data))throw Error("no replacement");
  const ref=found.result.data.matches[0]!.ref,before=f.counts();
  await expect(serveCorrect(f.ctx,{statement:"Use the alternative endpoint.",target:{world_claim:f.target},mode:"replace_object",object:{kind:"node",ref}})).rejects.toThrow();
  expect(f.counts()).toEqual(before);
  expect(getClaim(f.db,f.old)?.status).toBe("live");
 }finally{other.dispose();f.dispose();}
},120000);
test("scoped typed corrections still reject visible cycles before recording native evidence",async()=>{
 const f=await scene();try{
  await f.write("situation.requires",{kind:"subject",ref:f.ref("project:b")},{subject:"project:a"});
  const before=f.counts();
  await expect(f.correct()).rejects.toThrow("cycle");
  expect(f.counts()).toEqual(before);
  expect(getClaim(f.db,f.old)?.status).toBe("live");
 }finally{f.dispose();}
},120000);
for(const restriction of ["endpoint","type","time","relay","source"] as const)test(`a retained typed target cannot bypass current ${restriction} authorization`,async()=>{
 const f=await scene();try{
  if(restriction==="endpoint")setGrant(f.db,"scoped-corrector",{subjects:["project:a","project:b"]});
  if(restriction==="type")setGrant(f.db,"scoped-corrector",{types:["decision"]});
  if(restriction==="time")setGrant(f.db,"scoped-corrector",{until:"2000-01-01T00:00:00Z"});
  if(restriction==="relay")setGrant(f.db,"scoped-corrector",{relay_owner_corrections:false});
  if(restriction==="source")revokeSourceGrant(f.db,{source_key:f.sourceKey,expected_revision:1,operation_id:"scoped-correction-revoke"});
  const before=f.counts();
  await expect(f.correct()).rejects.toThrow();
  expect(f.counts()).toEqual(before);
  expect(getClaim(f.db,f.old)?.status).toBe("live");
 }finally{f.dispose();}
},120000);


test("typed refs preserve semantic subject scope and exact retired-target retries",async()=>{
 const f=await scene();try{
  const args={statement:"Project b depends on project a.",target:f.target,mode:"replace_object" as const,object:{kind:"node" as const,ref:f.replacement}};
  const out=await serveCorrect(f.ctx,args,"kizuki.envelope/v2");
  expect(out.data.claim?.kind).toBe("claim");
  expect(out.data.superseded).toEqual([f.target]);
  expect(getClaim(f.db,f.old)?.status).toBe("superseded");
  const before=f.counts();
  f.db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)").run("unrelated-pending","unrelated-source","{}","fixture");
  const replay=await serveCorrect(f.ctx,args,"kizuki.envelope/v2");
  expect(replay.data).toEqual(out.data);
  expect(f.counts()).toEqual(before);
 }finally{f.dispose();}
},120000);


test("typed correction rechecks the principal after the real native-capture preparation gap",async()=>{
 const f=await scene();try{
  const claims=f.counts()[1];
  const pending=serveCorrect(f.ctx,{statement:"Project b depends on project a.",target:f.target,mode:"replace_object",object:{kind:"node",ref:f.replacement}},"kizuki.envelope/v2");
  expect(f.db.query("SELECT count(*) n FROM native_owner_evidence").get()).toEqual({n:1});
  expect(getClaim(f.db,f.old)?.status).toBe("live");
  setGrant(f.db,"scoped-corrector",{subjects:["project:b"]});
  await expect(pending).rejects.toMatchObject({code:"not_found"});
  expect(getClaim(f.db,f.old)?.status).toBe("live");
  expect(f.counts()[1]).toBe(claims);
  // Already captured owner words retain capture custody; no claim or canon
  // authority is granted after the scope changes across preparation.
  expect(f.db.query("SELECT filing_state FROM native_owner_evidence").get()).toEqual({filing_state:"recorded"});
 }finally{f.dispose();}
},120000);
