import { expect,test } from "bun:test";
import { addAgent,authenticate,OWNER_AGENT_GRANT } from "../../src/agents";
import { accept } from "../../src/ledger/ledger";
import { servePropose } from "../../src/serving/propose";
import { serveWorldView } from "../../src/serving/world-view";
import { forecastJob } from "../../src/world/forecast/job";
import { validateForecastJournal } from "../../src/world/forecast/validate";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { enrollSource } from "../helpers/world-seed";
import { literal,vocabulary } from "../helpers/situation-v2-fixture";
import { cardFixture } from "./card-fixture";
import type { SituationCardV2 } from "../../src/contracts/situation-card-v2";
import type { ForecastScores } from "../../src/contracts/forecast";
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
   await f.write("commitment.due",literal("2026-10-24"),{subject});
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
