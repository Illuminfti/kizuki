import { join } from "node:path";
import { exportVault,restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { tempVault } from "../helpers/vault";
import { expect,test,setSystemTime } from "bun:test";
import { OWNER_AGENT_GRANT,addAgent,authenticate } from "../../src/agents";
import { servePropose } from "../../src/serving/propose";
import { serveWorldView } from "../../src/serving/world-view";
import { runWorldJobs } from "../../src/serve/world-jobs";
import { accept } from "../../src/ledger/ledger";
import { canonicalizeRfc3339Utc } from "../../src/util/time";
import { ulid } from "../../src/util/ulid";
import { inspectSourceGrant,setSourceGrant,revokeSourceGrant } from "../../src/ledger/source-grants";
import { purgeEvents } from "../../src/ledger/purge";
import { validEvent } from "../fixtures";
import { enrollSource } from "../helpers/world-seed";
import { situationV2Fixture,literal,vocabulary,SITUATION_REVIEW_DUE,SITUATION_REVIEW_DAY_AFTER,SITUATION_REVIEW_CONFLICT } from "../helpers/situation-v2-fixture";
import type { Forecast } from "../../src/contracts/forecast";
import { serveCorrect } from "../../src/serving/correct";
import { undoReceipt } from "../../src/canon/undo";
import { newReadFrame } from "../../src/world/pipeline/frame";
import { worldNamespace } from "../../src/world/references";
import { legacyProof } from "../../src/world/forecast/proof";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { validateForecastJournal } from "../../src/world/forecast/validate";
import { resupersedeClaim, reinstateClaim } from "../../src/claims/store";
import { calibratedProbability, parseForecastCalibration } from "../../src/world/forecast/calibration";
import { cardFixture } from "./card-fixture";
import type { SituationCardV2 } from "../../src/contracts/situation-card-v2";
const WHEN={valid:{kind:"all"},knownAt:{kind:"current"}} as const;
function assertJournalRestore(f:{db:ReturnType<typeof openLedger>;ctx:{vaultPath:string}}):void {
 const temp=tempVault("forecast-readmission-restore-");try{
  const before=f.db.query("SELECT * FROM world_forecast_resolutions ORDER BY forecast_id").all();
  const backup=join(temp.path,"backup"),restored=join(temp.path,"restored");
  exportVault(f.db,f.ctx.vaultPath,backup);restoreVault(backup,restored);
  const db=openLedger(join(restored,".kizuki/kizuki.db"));try{validateForecastJournal(db);expect(db.query("SELECT * FROM world_forecast_resolutions ORDER BY forecast_id").all()).toEqual(before);}finally{db.close();}
 }finally{temp.dispose();}
}

async function fixture(){
 const purposes=["capture","derive","recall","correction","export","session"] as const;
 const f=await situationV2Fixture(undefined,{purposes});
 const commitment=(ctx=f.ctx)=>f.readSituation(ctx).commitments.find(c=>c.due.some(r=>r.object.kind==="literal"&&r.object.value===SITUATION_REVIEW_DUE))!.commitment;
 await f.write("commitment.deliverable",literal("required fields reviewed"),{subject:"commitment:review"});
 const actors=["reporter","observer","reviewer"].map(name=>{
   const agent=addAgent(f.db,`forecast-${name}`,OWNER_AGENT_GRANT),connector=`forecast.${name}`;
   return {ctx:{...f.ctx,principal:authenticate(f.db,agent.token)!},connector,source:enrollSource(f.db,connector,"public",undefined,undefined,purposes)};
 });
 const file=async(index:number,predicate:string,result:string,patch:Record<string,unknown>={},sensitivity:"public"|"private"="public",occurredAt=new Date().toISOString())=>{
   const actor=actors[index]!;
   const captured=accept(f.db,{...validEvent(),occurred_at:occurredAt,connector_id:actor.connector,source_record_id:ulid(),text:`Independent ${actor.connector} ${predicate} ${ulid()}`,sensitivity_hint:sensitivity,subjects:[{subject_id:"commitment:review",role:"about"}]},{source:{source_key:actor.source,expected_revision:1}});
   if(captured.status!=="stored")throw Error("capture failed");
   const answer=await servePropose(actor.ctx,{kind:"claim",subject:"commitment:review",subjects:["commitment:review"],predicate,object:JSON.stringify({subjectRef:commitment(actor.ctx).token,task:"review",attempt:"attempt-1",criterion:"required fields reviewed",artifactVersion:"draft-1",environment:"synthetic",assistance:"assisted",confounded:false,result,...patch}),body:`Attributed ${predicate}`,provenance:[captured.event.event_id],confidence:0.8});
   expect(answer.data?.outcome).toBe("stored");return captured.event.event_id;
 };
 const run=async(at?:string)=>{
   const report=await runWorldJobs({db:f.db,vaultPath:f.ctx.vaultPath,now:()=>at??new Date().toISOString(),stopRequested:()=>false,modelConfigured:false});
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

test("a supported later prerequisite selects 0.25; attributed deadlines and conflicts abstain",async()=>{
 const f=await fixture();try{
  await f.declare("commitment:dependency","commitment","Dependency");
  await f.write("commitment.due",literal(SITUATION_REVIEW_DAY_AFTER),{subject:"commitment:dependency"});
  await f.write("situation.requires",{kind:"subject",ref:f.ref("commitment:dependency")},{subject:"project:launch"});
  await f.run();expect(f.read().records[0]!.probability).toBe(0.25);validateForecastJournal(f.db);
  // Notes has two attributed deadlines; neither becomes an objective forecast.
  expect(f.db.query("SELECT 1 FROM world_forecasts f JOIN semantic_bindings h ON h.handle_id=f.handle_id WHERE h.raw_id='commitment:notes'").get()).toBeNull();
  const count=f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecasts").get()!.n;
  await f.write("commitment.due",literal(SITUATION_REVIEW_CONFLICT),{subject:"commitment:review"});await f.run();
  expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecasts").get()!.n).toBe(count);
 }finally{f.dispose();}
},120_000);

test("hypothetical deadlines remain analysis and never enter score counts or ordinary current facts",async()=>{
 const f=await fixture();try{
  await f.write("commitment.due",literal(SITUATION_REVIEW_DAY_AFTER),{subject:"commitment:review",mode:"hypothetical"});await f.run();
  expect(f.read().records.filter(r=>r.class==="analysis")).toHaveLength(1);
  expect(f.read().records.filter(r=>r.class==="prediction")).toHaveLength(1);
  const card=f.readSituation();expect(JSON.stringify(card)).not.toContain("deterministic_dependency");
  expect(card.commitments.find(c=>c.commitment.token===f.commitment().token)!.due.filter(d=>d.perspective.mode==="hypothetical")).toHaveLength(1);
 }finally{f.dispose();}
},120_000);

test("source completion cannot resolve a forecast; native receipted completion can, and undo erases only that resolution",async()=>{
 const f=await fixture();try{
  await f.run();await f.write("commitment.status",vocabulary("commitment/done"),{subject:"commitment:review"});await f.run();
  expect(f.read().records.every(r=>r.status==="unresolved")).toBe(true);
  f.materialize("commitment:review");
  const entry=f.readSituation().commitments.find(c=>c.commitment.token===f.commitment().token)!;
  const answer=await serveCorrect(f.ctx,{statement:"I confirm that the review is completed now.",target:{world_claim:entry.statusBasis[0]!},mode:"replace_object",object:{kind:"vocabulary",id:"commitment/done"}});
  if(!answer.data||!("receipt_id" in answer.data)||typeof answer.data.receipt_id!=="string")throw Error("owner receipt missing");
  await f.run();expect(f.read().records.some(r=>r.status==="resolved_met")).toBe(true);validateForecastJournal(f.db);
  const count=f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecasts").get()!.n;
  await f.run();expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecasts").get()!.n).toBe(count);
  await undoReceipt({db:f.db,vault_path:f.ctx.vaultPath},answer.data.receipt_id);
  expect(f.read().records.every(r=>r.status==="unresolved")).toBe(true);
  expect(f.db.query("SELECT status,proof FROM world_forecast_resolutions").all()).toEqual([{status:"invalidated",proof:"[]"}]);
 }finally{f.dispose();}
},120_000);

for(const result of ["met","not_met"] as const)test(`late independent ${result} resolves inspection but cannot prove completion by the frozen deadline`,async()=>{
 const f=await fixture();try{
  const observed=`${SITUATION_REVIEW_DAY_AFTER}T01:00:00.000Z`,at=`${SITUATION_REVIEW_DAY_AFTER}T02:00:00.000Z`;
  await f.file(0,"outcome.self_report","met");await f.run();
  await f.file(1,"outcome.observation",result,{},"public",observed);await f.run(at);
  expect(f.read().records.find(r=>r.question==="commitment_met_by_due")!.status).toBe("unresolved");
  expect(f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!.status).toBe(result==="met"?"resolved_met":"resolved_not_met");
  expect(Date.parse(f.db.query<{resolved_at:string},[]>("SELECT resolved_at FROM world_forecast_resolutions").get()!.resolved_at)).toBe(Date.parse(observed));
  validateForecastJournal(f.db);
 }finally{f.dispose();}
},120_000);

test("restore refuses substituting a later successful inspection for the first independently failed inspection",async()=>{
 const f=await fixture();try{
  await f.file(0,"outcome.self_report","met");await f.run();
  await f.file(1,"outcome.observation","not_met");
  const event=await f.file(2,"outcome.observation","met");await f.run();
  expect(f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!.status).toBe("resolved_not_met");
  f.db.transaction(()=>{
   const id=f.db.query<{claim_id:string},[string]>("SELECT claim_id FROM claims WHERE provenance LIKE ?").get(`%${event}%`)!.claim_id;
   const proof=legacyProof(newReadFrame(f.ctx,worldNamespace(f.db,f.ctx.principal),{kind:"all"}),id)!;
   f.db.exec("DROP TRIGGER world_forecast_resolution_immutable");
   const observed=f.db.query<{occurred_at:string},[string]>("SELECT occurred_at FROM events WHERE event_id=?").get(event)!.occurred_at;
   f.db.query("UPDATE world_forecast_resolutions SET status='resolved_met',resolved_at=?,proof=? WHERE forecast_id IN (SELECT forecast_id FROM world_forecasts WHERE question='next_independent_inspection_meets_criterion')").run(canonicalizeRfc3339Utc(observed)!,JSON.stringify([proof]));
   expect(()=>validateForecastJournal(f.db)).toThrow("invalid forecast resolution result");
  })();
 }finally{f.dispose();}
},120_000);

test("identical-host-clock later imports cannot rewrite the first inspection across export and restore",async()=>{
 const t0=Date.now()+60_000;setSystemTime(new Date(t0));
 const f=await fixture(),temp=tempVault("forecast-order-");try{
  await f.file(0,"outcome.self_report","met");await f.run();
  setSystemTime(new Date(t0+1000));
  await f.file(1,"outcome.observation","not_met");await f.run();
  const first=f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!;
  expect(first.status).toBe("resolved_not_met");
  const event=await f.file(2,"outcome.observation","met",{},"public",new Date(t0+500).toISOString());await f.run();
  const collision=f.db.query<{asserted_at:string;recorded_at:string;sequence:number;recorded_sequence:number},[string]>("SELECT c.asserted_at,r.recorded_at,a.sequence,r.recorded_sequence FROM claims c JOIN world_forecast_outcome_admissions a USING(claim_id) CROSS JOIN world_forecast_resolutions r JOIN world_forecasts f USING(forecast_id) WHERE c.provenance LIKE ? AND f.question='next_independent_inspection_meets_criterion'").get(`%${event}%`)!;
  expect(Date.parse(collision.asserted_at)).toBe(Date.parse(collision.recorded_at));expect(collision.sequence).toBeGreaterThan(collision.recorded_sequence);
  expect(f.read().records.find(r=>r.question===first.question)).toEqual(first);validateForecastJournal(f.db);
  const original=f.db.query("SELECT * FROM world_forecast_resolutions ORDER BY forecast_id").all();
  const backup=join(temp.path,"backup"),restored=join(temp.path,"restored");exportVault(f.db,f.ctx.vaultPath,backup);restoreVault(backup,restored);
  const db=openLedger(join(restored,".kizuki/kizuki.db"));try{validateForecastJournal(db);expect(db.query("SELECT * FROM world_forecast_resolutions ORDER BY forecast_id").all()).toEqual(original);}finally{db.close();}
 }finally{f.dispose();temp.dispose();setSystemTime();}
},120_000);

test("Outcome admission positions roll back atomically and purge erases their claim locators",async()=>{
 const f=await fixture();try{
  const event=await f.file(0,"outcome.self_report","met");
  const id=f.db.query<{claim_id:string},[string]>("SELECT claim_id FROM claims WHERE provenance LIKE ?").get(`%${event}%`)!.claim_id;
  const clock=f.db.query("SELECT * FROM claim_history_clock").get(),positions=f.db.query("SELECT * FROM world_forecast_outcome_admissions").all();
  const columns=f.db.query<{name:string},[]>("PRAGMA table_info(claims)").all().map(c=>c.name),copy=ulid();
  expect(()=>f.db.transaction(()=>{
   const select=columns.map(name=>name==="claim_id"?"?":name==="claim_key"?"NULL":`"${name}"`).join(",");
   f.db.query(`INSERT INTO claims(${columns.map(n=>`"${n}"`).join(",")}) SELECT ${select} FROM claims WHERE claim_id=?`).run(copy,id);
   expect(f.db.query("SELECT 1 FROM world_forecast_outcome_admissions WHERE claim_id=?").get(copy)).not.toBeNull();throw Error("synthetic rollback");
  })()).toThrow("synthetic rollback");
  expect(f.db.query("SELECT * FROM claim_history_clock").get()).toEqual(clock);expect(f.db.query("SELECT * FROM world_forecast_outcome_admissions").all()).toEqual(positions);
  purgeEvents(f.db,f.ctx.vaultPath,{event_id:event},"erase outcome admission locator");
  expect(f.db.query("SELECT 1 FROM world_forecast_outcome_admissions WHERE claim_id=?").get(id)).toBeNull();
 }finally{f.dispose();}
},120_000);


test("revived earlier Outcome cannot enter a previously resolved forecast selection retroactively",async()=>{
 const f=await fixture();try{
  await f.file(0,"outcome.self_report","met");await f.run();
  const first=await f.file(1,"outcome.observation","not_met");
  const later=await f.file(2,"outcome.observation","met");
  const claim=(event:string)=>f.db.query<{claim_id:string},[string]>("SELECT claim_id FROM claims WHERE provenance LIKE ?").get(`%${event}%`)!.claim_id;
  resupersedeClaim(f.db,claim(first),claim(later),new Date().toISOString(),null);
  await f.run();
  const frozen=f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!;
  expect(frozen.status).toBe("resolved_met");validateForecastJournal(f.db);
  reinstateClaim(f.db,claim(first),null);
  expect(f.read().records.find(r=>r.question===frozen.question)).toEqual(frozen);
  expect(()=>validateForecastJournal(f.db)).not.toThrow();assertJournalRestore(f);
 }finally{f.dispose();}
},120_000);


test("reauthorized earlier Outcome cannot enter a saved resolution selection retroactively",async()=>{
 const f=await fixture();try{
  await f.file(0,"outcome.self_report","met");await f.run();
  await f.file(1,"outcome.observation","not_met");
  const source=f.actors[1]!.source,policy=inspectSourceGrant(f.db,source)!.policy;
  setSourceGrant(f.db,{source_key:source,expected_revision:1,operation_id:"forecast-inspection-hide",policy:{...policy,purposes:policy.purposes.filter(p=>p!=="derive")}});
  await f.file(2,"outcome.observation","met");await f.run();
  const frozen=f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!;
  expect(frozen.status).toBe("resolved_met");validateForecastJournal(f.db);
  const positions=f.db.query("SELECT * FROM world_forecast_outcome_admissions ORDER BY claim_id").all(),clock=f.db.query("SELECT * FROM claim_history_clock").get();
  expect(()=>f.db.transaction(()=>{
   setSourceGrant(f.db,{source_key:source,expected_revision:2,operation_id:"forecast-inspection-regrant",policy});throw Error("readmission rollback");
  })()).toThrow("readmission rollback");
  expect(f.db.query("SELECT * FROM world_forecast_outcome_admissions ORDER BY claim_id").all()).toEqual(positions);
  expect(f.db.query("SELECT * FROM claim_history_clock").get()).toEqual(clock);
  setSourceGrant(f.db,{source_key:source,expected_revision:2,operation_id:"forecast-inspection-regrant",policy});
  expect(f.read().records.find(r=>r.question===frozen.question)).toEqual(frozen);
  expect(()=>validateForecastJournal(f.db)).not.toThrow();assertJournalRestore(f);
 }finally{f.dispose();}
},120_000);


test("an inconclusive independent inspection is censored and later success cannot replace it",async()=>{
 const f=await fixture();try{
  await f.file(0,"outcome.self_report","met");await f.run();
  await f.file(1,"outcome.observation","inconclusive");await f.run();
  const initial=f.read().records.find(r=>r.question==="next_independent_inspection_meets_criterion")!;
  expect(initial.status).toBe("censored");expect(f.read().records.find(r=>r.question==="commitment_met_by_due")!.status).toBe("unresolved");
  await f.file(2,"outcome.observation","met");await f.run();
  expect(f.read().records.find(r=>r.question===initial.question)).toEqual(initial);validateForecastJournal(f.db);
 }finally{f.dispose();}
},120_000);

test("live calibrated forecast admission activates after 20 authorized resolutions, stays idempotent, validates across restore, and rejects private leakage",async()=>{
 const purposes=["capture","derive","recall","correction","export"] as const;
 const f=await cardFixture(undefined,{purposes:[...purposes]});
 try{
  await f.write("world.kind",vocabulary("world/situation"),{subject:"project:cal-board"});
  await f.write("situation.label",literal("Calibration board"),{subject:"project:cal-board"});
  for(let i=0;i<12;i++){
   const subject=`commitment:cal-${i}`;
   await f.write("world.kind",vocabulary("world/commitment"),{subject});
   await f.write("commitment.label",literal(`Cal item ${i}`),{subject});
   await f.write("commitment.due",literal(SITUATION_REVIEW_DUE),{subject});
   await f.write("commitment.deliverable",literal("reviewed"),{subject});
   await f.write("situation.has_commitment",{kind:"subject",ref:f.ref(subject)},{subject:"project:cal-board"});
  }
  const actors=["reporter","observer"].map(name=>{
   const agent=addAgent(f.db,`cal-${name}`,OWNER_AGENT_GRANT),connector=`forecast.cal.${name}`;
   return {ctx:{...f.ctx,principal:authenticate(f.db,agent.token)!},connector,source:enrollSource(f.db,connector,"public",undefined,undefined,[...purposes])};
  });
  const readBoard=(ctx:typeof f.ctx)=>{
   const found=serveWorldView(ctx,{operation:"find_situations",label:"Calibration board",...WHEN}).data as any;
   return (serveWorldView(ctx,{operation:"situation",situation:found.result.data.matches[0].ref,card:"kizuki.situation-card/v2",...WHEN}).data as any).result.data as SituationCardV2;
  };
  const fileOutcome=async(actorIndex:number,label:string,subject:string,result:"met"|"not_met")=>{
   const actor=actors[actorIndex]!;
   const captured=accept(f.db,{...validEvent(),occurred_at:new Date().toISOString(),connector_id:actor.connector,source_record_id:ulid(),text:`Calibrated ${actorIndex} ${subject} ${result} ${ulid()}`,sensitivity_hint:"public",subjects:[{subject_id:subject,role:"about"}]},{source:{source_key:actor.source,expected_revision:1}});
   if(captured.status!=="stored")throw Error("capture failed");
   const token=readBoard(actor.ctx).commitments.find(c=>c.label?.object.kind==="literal"&&c.label.object.value===label)!.commitment;
   const answer=await servePropose(actor.ctx,{kind:"claim",subject,subjects:[subject],predicate:actorIndex===0?"outcome.self_report":"outcome.observation",object:JSON.stringify({subjectRef:token.token,task:"review",attempt:"first",criterion:"reviewed",artifactVersion:"draft-1",environment:"test",result,assistance:"assisted",confounded:false}),body:"Calibrated inspection",provenance:[captured.event.event_id],confidence:0.8});
   expect(answer.data?.outcome).toBe("stored");
  };
  const run=async()=>{
   const report=await runWorldJobs({db:f.db,vaultPath:f.ctx.vaultPath,now:()=>new Date().toISOString(),stopRequested:()=>false,modelConfigured:false});
   expect(report.errors).toEqual([]);
  };

  // Freeze 24 cold-start predictions (all 0.5), then resolve 10 met (20 resolutions) + 2 not_met (2 inspection resolutions) = 22 resolved.
  for(let i=0;i<12;i++)await fileOutcome(0,`Cal item ${i}`,`commitment:cal-${i}`,"met");
  await run();await run();
  expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecasts WHERE probability=0.5").get()!.n).toBe(24);
  for(let i=0;i<12;i++)await fileOutcome(1,`Cal item ${i}`,`commitment:cal-${i}`,i<10?"met":"not_met");
  await run();await run();await run();
  expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecast_resolutions WHERE status IN ('resolved_met','resolved_not_met')").get()!.n).toBe(22);

  // Add a 13th commitment after >= 20 authorized resolutions exist; it must receive calibrated probabilities.
  const nextSubject="commitment:cal-live";
  await f.write("world.kind",vocabulary("world/commitment"),{subject:nextSubject});
  await f.write("commitment.label",literal("Cal item live"),{subject:nextSubject});
  await f.write("commitment.due",literal(SITUATION_REVIEW_DUE),{subject:nextSubject});
  await f.write("commitment.deliverable",literal("reviewed"),{subject:nextSubject});
  await f.write("situation.has_commitment",{kind:"subject",ref:f.ref(nextSubject)},{subject:"project:cal-board"});
  await fileOutcome(0,"Cal item live",nextSubject,"met");
  await run();await run();await run();

  const liveRef=readBoard(f.ctx).commitments.find(c=>c.label?.object.kind==="literal"&&c.label.object.value==="Cal item live")!.commitment;
  const liveForecast=(serveWorldView(f.ctx,{operation:"forecast",commitment:liveRef,...WHEN}).data as any).result.data as Forecast;
  expect(liveForecast.records).toHaveLength(2);
  // commitment_met_by_due: 10 met / 10 resolved; next_independent_inspection_meets_criterion: 10 met / 12 resolved.
  const expectedByDue=calibratedProbability(0.5,4,10,10);
  const expectedByInspection=calibratedProbability(0.5,4,10,12);
  const dueRec=liveForecast.records.find(r=>r.question==="commitment_met_by_due")!;
  const inspRec=liveForecast.records.find(r=>r.question==="next_independent_inspection_meets_criterion")!;
  expect(dueRec.probability).toBe(expectedByDue);
  expect(inspRec.probability).toBe(expectedByInspection);
  expect(dueRec.probability).toBeGreaterThan(inspRec.probability);
  expect(inspRec.probability).toBeGreaterThan(0.5);

  // Stored conditions carry a strict, replay-verifiable calibration snapshot.
  const liveRows=f.db.query<{conditions:string|null},[]>("SELECT f.conditions FROM world_forecasts f JOIN semantic_bindings b USING(handle_id) WHERE b.raw_id='commitment:cal-live'").all();
  expect(liveRows).toHaveLength(2);
  for(const row of liveRows){
   const parsed=JSON.parse(row.conditions!);
   expect(parseForecastCalibration(parsed.calibration)).not.toBeNull();
  }

  // Idempotency: running the job again after another resolution must not duplicate unchanged commitments.
  const countBefore=f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecasts").get()!.n;
  await run();await run();
  expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecasts").get()!.n).toBe(countBefore);

  // Restore validation passes and rejects forged calibrated probabilities.
  validateForecastJournal(f.db);
  assertJournalRestore(f);
  f.db.transaction(()=>{
   f.db.exec("DROP TRIGGER world_forecast_immutable");
   f.db.query("UPDATE world_forecasts SET probability=0.99 WHERE handle_id=(SELECT handle_id FROM semantic_bindings WHERE raw_id='commitment:cal-live')").run();
   expect(()=>validateForecastJournal(f.db)).toThrow("invalid frozen forecast journal");
   throw Error("rollback tamper check");
  })();
 }catch(error){
  if(!(error instanceof Error)||error.message!=="rollback tamper check")throw error;
 }finally{f.dispose();}
},180_000);

test("private resolved forecasts cannot influence a public commitment's live calibration",async()=>{
 const purposes=["capture","derive","recall","correction","export"] as const;
 const f=await cardFixture(undefined,{purposes:[...purposes]});
 try{
  await f.write("world.kind",vocabulary("world/situation"),{subject:"project:priv-cal",floor:"private"});
  await f.write("situation.label",literal("Private calibration board"),{subject:"project:priv-cal",floor:"private"});
  for(let i=0;i<10;i++){
   const subject=`commitment:priv-${i}`;
   await f.write("world.kind",vocabulary("world/commitment"),{subject,floor:"private"});
   await f.write("commitment.label",literal(`Priv item ${i}`),{subject,floor:"private"});
   await f.write("commitment.due",literal(SITUATION_REVIEW_DUE),{subject,floor:"private"});
   await f.write("commitment.deliverable",literal("reviewed"),{subject,floor:"private"});
   await f.write("situation.has_commitment",{kind:"subject",ref:f.ref(subject)},{subject:"project:priv-cal",floor:"private"});
  }
  const actors=["reporter","observer"].map(name=>{
   const agent=addAgent(f.db,`priv-cal-${name}`,OWNER_AGENT_GRANT),connector=`forecast.priv.${name}`;
   return {ctx:{...f.ctx,principal:authenticate(f.db,agent.token)!},connector,source:enrollSource(f.db,connector,"private",undefined,undefined,[...purposes])};
  });
  const readBoard=(actor:typeof actors[number])=>{
   const found=serveWorldView(actor.ctx,{operation:"find_situations",label:"Private calibration board",...WHEN}).data as any;
   return (serveWorldView(actor.ctx,{operation:"situation",situation:found.result.data.matches[0].ref,card:"kizuki.situation-card/v2",...WHEN}).data as any).result.data as SituationCardV2;
  };
  const file=async(actorIndex:number,i:number)=>{
   const actor=actors[actorIndex]!,subject=`commitment:priv-${i}`;
   const captured=accept(f.db,{...validEvent(),occurred_at:new Date().toISOString(),connector_id:actor.connector,source_record_id:ulid(),text:`Private cal ${actorIndex} ${i} ${ulid()}`,sensitivity_hint:"private",subjects:[{subject_id:subject,role:"about"}]},{source:{source_key:actor.source,expected_revision:1}});
   if(captured.status!=="stored")throw Error("capture failed");
   const token=readBoard(actor).commitments.find(c=>c.label?.object.kind==="literal"&&c.label.object.value===`Priv item ${i}`)!.commitment;
   const answer=await servePropose(actor.ctx,{kind:"claim",subject,subjects:[subject],predicate:actorIndex===0?"outcome.self_report":"outcome.observation",object:JSON.stringify({subjectRef:token.token,task:"review",attempt:"first",criterion:"reviewed",artifactVersion:"draft-1",environment:"test",result:"met",assistance:"assisted",confounded:false}),body:"Private inspection",provenance:[captured.event.event_id],confidence:0.8});
   expect(answer.data?.outcome).toBe("stored");
  };
  const run=async()=>{
   const report=await runWorldJobs({db:f.db,vaultPath:f.ctx.vaultPath,now:()=>new Date().toISOString(),stopRequested:()=>false,modelConfigured:false});
   expect(report.errors).toEqual([]);
  };
  for(let i=0;i<10;i++)await file(0,i);
  await run();await run();
  for(let i=0;i<10;i++)await file(1,i);
  await run();await run();await run();
  expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecast_resolutions WHERE status='resolved_met'").get()!.n).toBe(20);

  // Now add a strictly PUBLIC commitment on a public source: it must NOT borrow private calibration history.
  const pub=await cardFixture(f.db,{purposes:[...purposes]});
  try{
   await pub.write("world.kind",vocabulary("world/commitment"),{subject:"commitment:public-isolated",floor:"public"});
   await pub.write("commitment.label",literal("Public isolated item"),{subject:"commitment:public-isolated",floor:"public"});
   await pub.write("commitment.due",literal(SITUATION_REVIEW_DUE),{subject:"commitment:public-isolated",floor:"public"});
   await run();await run();await run();
   const pubRow=f.db.query<{probability:number;conditions:string|null},[]>("SELECT f.probability, f.conditions FROM world_forecasts f JOIN semantic_bindings b USING(handle_id) WHERE b.raw_id='commitment:public-isolated'").get()!;
   expect(pubRow.probability).toBe(0.5);
   expect(pubRow.conditions).toBeNull();
  }finally{pub.dispose();}
 }finally{f.dispose();}
},180_000);
