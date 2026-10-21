import { expect,test } from "bun:test";
import { join } from "node:path";
import { exportVault,restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { rebuildWorldLayer } from "../../src/derived";
import { forecastJob } from "../../src/world/forecast/job";
import { forecastFingerprint } from "../../src/world/forecast/store";
import { validateForecastJournal } from "../../src/world/forecast/validate";
import { situationV2Fixture } from "../helpers/situation-v2-fixture";
import { tempVault } from "../helpers/vault";
import { revokeSourceGrant } from "../../src/ledger/source-grants";

async function seeded(){
 const f=await situationV2Fixture(undefined,{purposes:["capture","derive","recall","correction","export","session"]});
 await forecastJob.run({db:f.db,vaultPath:f.ctx.vaultPath,now:()=>new Date().toISOString(),stopRequested:()=>false,modelConfigured:false});
 const row=f.db.query<{forecast_id:string},[]>("SELECT forecast_id FROM world_forecasts").get();expect(row).not.toBeNull();return {...f,id:row!.forecast_id};
}
test("forecast authority survives rebuild, export/restore and reopen with exact immutable inputs",async()=>{
 const f=await seeded(),temp=tempVault("forecast-restore-");try{
  const before=forecastFingerprint(f.db,f.id);rebuildWorldLayer(f.db);expect(forecastFingerprint(f.db,f.id)).toBe(before);
  const backup=join(temp.path,"backup"),restored=join(temp.path,"restored");
  exportVault(f.db,f.ctx.vaultPath,backup);restoreVault(backup,restored);
  const db=openLedger(join(restored,".kizuki/kizuki.db"));try{validateForecastJournal(db);expect(forecastFingerprint(db,f.id)).toBe(before);}finally{db.close();}
 }finally{f.dispose();temp.dispose();}
},120_000);
test("append-only input and resolution rows roll back with their parent, and source loss erases private cursors",async()=>{
 const f=await seeded();try{
  expect(()=>f.db.exec("UPDATE world_forecast_inputs SET proof='{}'")).toThrow("append only");
  const original=f.db.query("SELECT * FROM world_forecast_inputs").all();
  expect(()=>f.db.transaction(()=>{f.db.query("DELETE FROM world_forecasts WHERE forecast_id=?").run(f.id);throw Error("rollback");})()).toThrow("rollback");
  expect(f.db.query("SELECT * FROM world_forecast_inputs").all()).toEqual(original);
  f.db.query("INSERT OR REPLACE INTO rail_cursors(rail,source_key,cursor,updated_at) VALUES ('forecast','resolution',?,?)").run(JSON.stringify(f.id),new Date().toISOString());
  revokeSourceGrant(f.db,{source_key:f.sourceKey,expected_revision:1,operation_id:"forecast-storage-revoke"});
  expect(f.db.query("SELECT 1 FROM world_forecasts").get()).toBeNull();
  expect(f.db.query("SELECT 1 FROM rail_cursors WHERE rail='forecast' AND source_key='resolution'").get()).toBeNull();
 }finally{f.dispose();}
},120_000);
