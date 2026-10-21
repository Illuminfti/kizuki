import { expect,test } from "bun:test";
import { OWNER_AGENT_GRANT,addAgent,authenticate } from "../../src/agents";
import { servePropose } from "../../src/serving/propose";
import { serveWorldView } from "../../src/serving/world-view";
import { runWorldJobs } from "../../src/serve/world-jobs";
import { accept } from "../../src/ledger/ledger";
import { ulid } from "../../src/util/ulid";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { purgeEvents } from "../../src/ledger/purge";
import { validEvent } from "../fixtures";
import { enrollSource } from "../helpers/world-seed";
import { situationV2Fixture,literal } from "../helpers/situation-v2-fixture";
import type { Forecast } from "../../src/contracts/forecast";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { validateForecastJournal } from "../../src/world/forecast/store";
const WHEN={valid:{kind:"all"},knownAt:{kind:"current"}} as const;
async function fixture(){
 const purposes=["capture","derive","recall","correction","export","session"] as const;
 const f=await situationV2Fixture(undefined,{purposes});
 const commitment=(ctx=f.ctx)=>f.readSituation(ctx).commitments.find(c=>c.due.some(r=>r.object.kind==="literal"&&r.object.value==="2026-10-24"))!.commitment;
 await f.write("commitment.deliverable",literal("required fields reviewed"),{subject:"commitment:review"});
 const actors=["reporter","observer","reviewer"].map(name=>{
   const agent=addAgent(f.db,`forecast-${name}`,OWNER_AGENT_GRANT),connector=`forecast.${name}`;
   return {ctx:{...f.ctx,principal:authenticate(f.db,agent.token)!},connector,source:enrollSource(f.db,connector,"public",undefined,undefined,purposes)};
 });
 const file=async(index:number,predicate:string,result:string,patch:Record<string,unknown>={},sensitivity:"public"|"private"="public")=>{
   const actor=actors[index]!;
   const captured=accept(f.db,{...validEvent(),occurred_at:new Date().toISOString(),connector_id:actor.connector,source_record_id:ulid(),text:`Independent ${actor.connector} ${predicate} ${ulid()}`,sensitivity_hint:sensitivity,subjects:[{subject_id:"commitment:review",role:"about"}]},{source:{source_key:actor.source,expected_revision:1}});
   if(captured.status!=="stored")throw Error("capture failed");
   const answer=await servePropose(actor.ctx,{kind:"claim",subject:"commitment:review",subjects:["commitment:review"],predicate,object:JSON.stringify({subjectRef:commitment(actor.ctx).token,task:"review",attempt:"attempt-1",criterion:"required fields reviewed",artifactVersion:"draft-1",environment:"synthetic",assistance:"assisted",confounded:false,result,...patch}),body:`Attributed ${predicate}`,provenance:[captured.event.event_id],confidence:0.8});
   expect(answer.data?.outcome).toBe("stored");return captured.event.event_id;
 };
 const run=async()=>{
   const report=await runWorldJobs({db:f.db,vaultPath:f.ctx.vaultPath,now:()=>new Date().toISOString(),stopRequested:()=>false,modelConfigured:false});
   expect(report.errors).toEqual([]);
 };
 const read=(ctx=f.ctx,when:Record<string,unknown>={})=>{
   const answer=serveWorldView(ctx,{operation:"forecast",commitment:commitment(ctx),...WHEN,...when}).data;
   if(!("result" in answer)||!("data" in answer.result))throw Error(`forecast unavailable ${JSON.stringify(answer)}`);
   return answer.result.data as Forecast;
 };
 return {...f,actors,file,run,read,commitment};
}

test("actual background job freezes a model-free baseline and public reads do not create or rewrite it",async()=>{
 const f=await fixture();try{
  expect(serveWorldView(f.ctx,{operation:"forecast",commitment:f.commitment(),...WHEN}).data).toMatchObject({status:"not_found"});
  await f.run();const before=f.read();
  expect(before.baseline.interpretation).toBe("uncalibrated_heuristic");expect(before.baseline.model).toBe("none");
  expect(before.records).toHaveLength(1);expect(before.records[0]!.probability).toBe(0.5);expect(before.records[0]!.status).toBe("unresolved");
  const saved=f.db.query("SELECT * FROM world_forecasts").all();await f.run();expect(f.db.query("SELECT * FROM world_forecasts").all()).toEqual(saved);
  await f.write("commitment.label",literal("Later alternative label"),{subject:"commitment:review"});
  expect(f.read().records[0]).toEqual(before.records[0]);
  expect(()=>f.db.exec("UPDATE world_forecasts SET probability=1")).toThrow("append only");
  validateForecastJournal(f.db);
  expect(serveWorldView(f.ctx,{operation:"forecast_scores",...WHEN}).data).toMatchObject({result:{status:"unavailable",reason:"history"}});
 }finally{f.dispose();}
},120_000);

test("the first independently inspected wrong version resolves false and later success never rewrites that prediction",async()=>{
 const f=await fixture();try{
  await f.file(0,"outcome.self_report","met");await f.file(0,"outcome.provider_ack","acknowledged");await f.run();
  const initial=f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!;
  expect(initial.status).toBe("unresolved");
  await f.file(0,"outcome.observation","met");await f.run();expect(f.read().records.find(r=>r.question===initial.question)!.status).toBe("unresolved");
  await f.file(1,"outcome.observation","met",{artifactVersion:"draft-wrong"});await f.run();
  const wrong=f.read().records.find(r=>r.question===initial.question)!;
  expect(wrong.status).toBe("resolved_not_met");expect(wrong.inputs).toEqual(initial.inputs);expect(wrong.frozenAt).toBe(initial.frozenAt);
  await f.file(2,"outcome.observation","met");await f.run();expect(f.read().records.find(r=>r.question===initial.question)).toEqual(wrong);
  const historical=f.read(f.ctx,{knownAt:{kind:"time",at:initial.frozenAt}}).records.find(r=>r.question===initial.question)!;
  expect(historical.status).toBe("unresolved");expect(historical.inputs).toEqual(initial.inputs);
 }finally{f.dispose();}
},120_000);

for(const loss of ["revoke","purge"] as const)test(`resolution ${loss} erases its proof without removing or later rewriting the frozen prediction`,async()=>{
 const f=await fixture();try{
  await f.file(0,"outcome.self_report","met");await f.run();const event=await f.file(1,"outcome.observation","not_met");await f.run();
  expect(f.read().records.some(r=>r.status==="resolved_not_met")).toBe(true);
  const count=f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecasts WHERE question='next_independent_inspection_meets_criterion'").get()!.n;expect(count).toBe(1);
  if(loss==="revoke")revokeSourceGrant(f.db,{source_key:f.actors[1]!.source,expected_revision:1,operation_id:"forecast-revoke"});
  else purgeEvents(f.db,f.ctx.vaultPath,{event_id:event},"erase synthetic forecast resolution");
  expect(f.db.query("SELECT r.status,r.proof,r.resolved_at,r.recorded_at,f.frozen_at FROM world_forecast_resolutions r JOIN world_forecasts f USING(forecast_id) WHERE question='next_independent_inspection_meets_criterion'").get()).toMatchObject({status:"invalidated",proof:"[]"});
  expect(f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!.status).toBe("unresolved");
  await f.file(2,"outcome.observation","met");await f.run();
  expect(f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!.status).toBe("unresolved");
  validateForecastJournal(f.db);
  expect(JSON.stringify(f.readSituation())).not.toContain("deterministic_dependency");
 }finally{f.dispose();}
},120_000);

for(const loss of ["revoke","purge"] as const)test(`hidden resolution ${loss} changes neither public prediction bytes nor measured work`,async()=>{
 const f=await fixture();try{
  await f.file(0,"outcome.self_report","met");await f.run();
  const agent=addAgent(f.db,"public-forecast-reader",{...OWNER_AGENT_GRANT,ceiling:"public"});
  const ctx={...f.ctx,principal:authenticate(f.db,agent.token)!};
  const inspect=()=>{const r=collectReadFrames(()=>f.read(ctx));return {data:r.result,stats:r.frames.map(f=>({...f.stats}))};};
  const before=inspect();
  const event=await f.file(1,"outcome.observation","not_met",{},"private");await f.run();
  expect(f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!.status).toBe("resolved_not_met");
  expect(inspect()).toEqual(before);
  if(loss==="revoke")revokeSourceGrant(f.db,{source_key:f.actors[1]!.source,expected_revision:1,operation_id:"private-resolution-revoke"});
  else purgeEvents(f.db,f.ctx.vaultPath,{event_id:event},"erase hidden resolution");
  expect(inspect()).toEqual(before);
  const row=f.db.query<{status:string;proof:string;resolved_at:string;recorded_at:string;frozen_at:string},[]>("SELECT r.status,r.proof,r.resolved_at,r.recorded_at,f.frozen_at FROM world_forecast_resolutions r JOIN world_forecasts f USING(forecast_id) WHERE question='next_independent_inspection_meets_criterion'").get()!;
  expect(row.status).toBe("invalidated");expect(row.proof).toBe("[]");expect(row.resolved_at).toBe(row.frozen_at);expect(row.recorded_at).toBe(row.frozen_at);
  await f.file(2,"outcome.observation","met",{},"private");await f.run();expect(inspect()).toEqual(before);
 }finally{f.dispose();}
},120_000);
