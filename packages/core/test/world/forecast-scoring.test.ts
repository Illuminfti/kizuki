import { expect,test } from "bun:test";
import { addAgent,authenticate,OWNER,OWNER_AGENT_GRANT } from "../../src/agents";
import { accept } from "../../src/ledger/ledger";
import { servePropose } from "../../src/serving/propose";
import { serveWorldView } from "../../src/serving/world-view";
import { forecastJob } from "../../src/world/forecast/job";
import { calibratedProbability, scoreForecastCalibration } from "../../src/world/forecast/calibration";
import { readForecastCalibration } from "../../src/world/forecast/read";
import { validateForecastJournal } from "../../src/world/forecast/validate";
import { worldNamespace } from "../../src/world/references";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { enrollSource } from "../helpers/world-seed";
import { literal,vocabulary,SITUATION_REVIEW_DUE } from "../helpers/situation-v2-fixture";
import { cardFixture } from "./card-fixture";
import type { SituationCardV2 } from "../../src/contracts/situation-card-v2";
import type { Forecast, ForecastScores } from "../../src/contracts/forecast";
const WHEN={valid:{kind:"all"},knownAt:{kind:"current"}} as const;
test("twenty actually observed frozen predictions open the reporting gate; Brier, cost and usefulness stay separate",async()=>{
 const f=await cardFixture(undefined,{purposes:["capture","derive","recall","correction","export"]});
 try{
  await f.write("world.kind",vocabulary("world/situation"),{subject:"project:forecasts"});
  await f.write("situation.label",literal("Forecast board"),{subject:"project:forecasts"});
  for(let i=0;i<10;i++){
   const subject=`commitment:score-${i}`;
   await f.write("world.kind",vocabulary("world/commitment"),{subject});
   await f.write("commitment.label",literal(`Item ${i}`),{subject});
   await f.write("commitment.due",literal(SITUATION_REVIEW_DUE),{subject});
   await f.write("commitment.deliverable",literal("reviewed"),{subject});
   await f.write("situation.has_commitment",{kind:"subject",ref:f.ref(subject)},{subject:"project:forecasts"});
  }
  const actors=["reporter","observer"].map(name=>{
   const agent=addAgent(f.db,`score-${name}`,OWNER_AGENT_GRANT),connector=`forecast.score.${name}`;
   return {ctx:{...f.ctx,principal:authenticate(f.db,agent.token)!},connector,source:enrollSource(f.db,connector,"public",undefined,undefined,["capture","derive","recall","correction","export"])};
  });
  const cards=actors.map(actor=>{
   const discovery=serveWorldView(actor.ctx,{operation:"find_situations",label:"Forecast board",...WHEN}).data as any;
   return (serveWorldView(actor.ctx,{operation:"situation",situation:discovery.result.data.matches[0].ref,card:"kizuki.situation-card/v2",...WHEN}).data as any).result.data as SituationCardV2;
  });
  const file=async(index:number,n:number)=>{
   const actor=actors[index]!,subject=`commitment:score-${n}`;
   const captured=accept(f.db,{...validEvent(),occurred_at:new Date().toISOString(),connector_id:actor.connector,source_record_id:ulid(),text:`Separate scoring ${index} ${n} ${ulid()}`,sensitivity_hint:"public",subjects:[{subject_id:subject,role:"about"}]},{source:{source_key:actor.source,expected_revision:1}});
   if(captured.status!=="stored")throw Error("capture failed");
   const token=cards[index]!.commitments.find(c=>c.label?.object.kind==="literal"&&c.label.object.value===`Item ${n}`)!.commitment;
   const result=await servePropose(actor.ctx,{kind:"claim",subject,subjects:[subject],predicate:index===0?"outcome.self_report":"outcome.observation",object:JSON.stringify({subjectRef:token.token,task:"review",attempt:"first",criterion:"reviewed",artifactVersion:"draft-1",environment:"test",result:"met",assistance:"assisted",confounded:false}),body:"Review inspected",provenance:[captured.event.event_id],confidence:0.8});
   expect(result.data?.outcome).toBe("stored");
  };
  const run=()=>forecastJob.run({db:f.db,vaultPath:f.ctx.vaultPath,now:()=>new Date().toISOString(),stopRequested:()=>false,modelConfigured:false});
  for(let i=0;i<10;i++)await file(0,i);
  await run();await run();expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecasts").get()!.n).toBe(20);
  for(let i=0;i<9;i++)await file(1,i);
  await run();await run();await run();
  const read=()=>serveWorldView(f.ctx,{operation:"forecast_scores",...WHEN}).data;
  expect(read()).toMatchObject({result:{status:"unavailable",reason:"history"}});
  expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM world_forecast_resolutions").get()!.n).toBe(18);
  await file(1,9);await run();await run();await run();
  const answer=read() as any,scores=answer.result.data as ForecastScores;
  expect(scores.resolved).toBe(20);expect(scores.unresolved).toBe(0);expect(scores.censored).toBe(0);expect(scores.brier).toBe(0.25);expect(scores.certainWrong).toBe(0);
  expect(scores.cost.predictions).toBe(20);expect(scores.cost.unknown).toContainEqual({metric:"retries",reason:"not_metered"});
  expect(scores.usefulness).toEqual({status:"unavailable",reason:"insufficient_history"});expect(scores.baseline.minimumResolved).toBe(20);
  validateForecastJournal(f.db);
 }finally{f.dispose();}
},180_000);

test("multi-object calibrated admission lowers live Brier score and satisfies Murphy Brier decomposition",async()=>{
 const purposes=["capture","derive","recall","correction","export"] as const;
 const f=await cardFixture(undefined,{purposes:[...purposes]});
 try{
  await f.write("world.kind",vocabulary("world/situation"),{subject:"project:multi-cal"});
  await f.write("situation.label",literal("Multi-object calibrated board"),{subject:"project:multi-cal"});
  const addCommitment=async(index:number)=>{
   const subject=`commitment:mc-${index}`;
   await f.write("world.kind",vocabulary("world/commitment"),{subject});
   await f.write("commitment.label",literal(`MC Item ${index}`),{subject});
   await f.write("commitment.due",literal(SITUATION_REVIEW_DUE),{subject});
   await f.write("commitment.deliverable",literal("reviewed"),{subject});
   await f.write("situation.has_commitment",{kind:"subject",ref:f.ref(subject)},{subject:"project:multi-cal"});
  };
  for(let i=0;i<10;i++)await addCommitment(i);

  const actors=["reporter","observer"].map(name=>{
   const agent=addAgent(f.db,`mc-${name}`,OWNER_AGENT_GRANT),connector=`forecast.mc.${name}`;
   return {ctx:{...f.ctx,principal:authenticate(f.db,agent.token)!},connector,source:enrollSource(f.db,connector,"public",undefined,undefined,[...purposes])};
  });
  const cardOf=(ctx:typeof f.ctx)=>{
   const discovery=serveWorldView(ctx,{operation:"find_situations",label:"Multi-object calibrated board",...WHEN}).data as any;
   return (serveWorldView(ctx,{operation:"situation",situation:discovery.result.data.matches[0].ref,card:"kizuki.situation-card/v2",...WHEN}).data as any).result.data as SituationCardV2;
  };
  const file=async(actorIndex:number,n:number,result:"met"|"not_met")=>{
   const actor=actors[actorIndex]!,subject=`commitment:mc-${n}`;
   const captured=accept(f.db,{...validEvent(),occurred_at:new Date().toISOString(),connector_id:actor.connector,source_record_id:ulid(),text:`Multi calibrated ${actorIndex} ${n} ${result} ${ulid()}`,sensitivity_hint:"public",subjects:[{subject_id:subject,role:"about"}]},{source:{source_key:actor.source,expected_revision:1}});
   if(captured.status!=="stored")throw Error("capture failed");
   const token=cardOf(actor.ctx).commitments.find(c=>c.label?.object.kind==="literal"&&c.label.object.value===`MC Item ${n}`)!.commitment;
   const answer=await servePropose(actor.ctx,{kind:"claim",subject,subjects:[subject],predicate:actorIndex===0?"outcome.self_report":"outcome.observation",object:JSON.stringify({subjectRef:token.token,task:"review",attempt:"first",criterion:"reviewed",artifactVersion:"draft-1",environment:"test",result,assistance:"assisted",confounded:false}),body:"Multi-object review inspected",provenance:[captured.event.event_id],confidence:0.8});
   expect(answer.data?.outcome).toBe("stored");
  };
  const run=()=>forecastJob.run({db:f.db,vaultPath:f.ctx.vaultPath,now:()=>new Date().toISOString(),stopRequested:()=>false,modelConfigured:false});

  // Wave 1 (cold start): 10 commitments -> 20 predictions at 0.5 -> all 20 resolve met (Brier = 0.25).
  for(let i=0;i<10;i++)await file(0,i,"met");
  await run();await run();
  for(let i=0;i<10;i++)await file(1,i,"met");
  await run();await run();await run();
  const wave1=(serveWorldView(f.ctx,{operation:"forecast_scores",...WHEN}).data as any).result.data as ForecastScores;
  expect(wave1.resolved).toBe(20);
  expect(wave1.brier).toBe(0.25);

  // Wave 2 (calibrated live admission): 4 new commitments admitted after 20 resolved predictions.
  for(let i=10;i<14;i++){await addCommitment(i);await file(0,i,"met");}
  await run();await run();await run();
  const expectedCalibrated=calibratedProbability(0.5,4,10,10);
  expect(expectedCalibrated).toBeCloseTo(12/14,6);

  const liveCard=cardOf(f.ctx);
  const mc10=liveCard.commitments.find(c=>c.label?.object.kind==="literal"&&c.label.object.value==="MC Item 10")!.commitment;
  const mc10Forecast=(serveWorldView(f.ctx,{operation:"forecast",commitment:mc10,...WHEN}).data as any).result.data as Forecast;
  expect(mc10Forecast.records).toHaveLength(2);
  expect(mc10Forecast.records.every(r=>r.probability===expectedCalibrated)).toBe(true);

  // Resolve wave 2: 3 met (6 resolutions) and 1 not_met (1 inspection resolution -> 7 new resolutions, 27 total).
  for(let i=10;i<14;i++)await file(1,i,i<13?"met":"not_met");
  await run();await run();await run();

  const wave2=(serveWorldView(f.ctx,{operation:"forecast_scores",...WHEN}).data as any).result.data as ForecastScores;
  expect(wave2.resolved).toBe(27);
  expect(wave2.unresolved).toBe(1);
  expect(wave2.certainWrong).toBe(0);
  // 20 cold-start met at 0.5 + 6 calibrated met at 12/14 + 1 calibrated not_met at 12/14.
  const expectedBrier=(20*(0.5-1)**2 + 6*(expectedCalibrated-1)**2 + 1*(expectedCalibrated-0)**2)/27;
  expect(wave2.brier as number).toBeCloseTo(expectedBrier,12);
  expect(wave2.brier as number).toBeLessThan(wave1.brier as number);

  // Diagnostics via readForecastCalibration match exact Brier and Murphy identity: Reliability - Resolution + Uncertainty = Brier.
  const diag=f.db.transaction(()=>readForecastCalibration({ctx:{...f.ctx,principal:OWNER},ns:worldNamespace(f.db,OWNER)},null,WHEN)).immediate()!;
  expect(diag.resolved).toBe(27);
  expect(diag.met).toBe(26);
  expect(diag.notMet).toBe(1);
  expect(diag.unresolved).toBe(1);
  expect(diag.brier).toBeCloseTo(expectedBrier,12);
  expect(diag.reliability!-diag.resolution!+diag.uncertainty!).toBeCloseTo(diag.brier!,12);
  expect(diag.ece).toBeGreaterThanOrEqual(0);
  expect(diag.bins.length).toBeGreaterThanOrEqual(2);

  // Pure scorer sanity check: sharp calibrated predictions beat uncalibrated 0.5 on skewed outcomes.
  const skewed=scoreForecastCalibration([
   ...Array.from({length:18},()=>({probability:expectedCalibrated,status:"resolved_met" as const})),
   ...Array.from({length:2},()=>({probability:expectedCalibrated,status:"resolved_not_met" as const})),
  ]);
  expect(skewed.brier!).toBeLessThan(0.11);
  expect(skewed.brierSkillScore!).toBeGreaterThan(-0.15);
  expect(skewed.reliability!-skewed.resolution!+skewed.uncertainty!).toBeCloseTo(skewed.brier!,12);

  validateForecastJournal(f.db);
 }finally{f.dispose();}
},180_000);
