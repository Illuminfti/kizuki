import { expect,test } from "bun:test";
import { skipUnwrittenClaim } from "../../src/claims/store";
import { forecastJob } from "../../src/world/forecast/job";
import { situationV2Fixture } from "../helpers/situation-v2-fixture";
test("skipping an unwritten forecast input reports its own mutation despite history and erasure triggers",async()=>{
 const f=await situationV2Fixture();try{
  await forecastJob.run({db:f.db,vaultPath:f.ctx.vaultPath,now:()=>new Date().toISOString(),stopRequested:()=>false,modelConfigured:false});
  expect(f.db.query("SELECT 1 FROM world_forecasts").get()).not.toBeNull();
  if(f.c2.stored.outcome!=="stored")throw Error("deadline missing");
  expect(skipUnwrittenClaim(f.db,f.c2.stored.claim.claim_id,new Date().toISOString())).toBe(true);
  expect(f.db.query("SELECT 1 FROM world_forecasts").get()).toBeNull();
  expect(skipUnwrittenClaim(f.db,f.c2.stored.claim.claim_id,new Date().toISOString())).toBe(false);
 }finally{f.dispose();}
},120_000);
