import { setImmediate as yieldToHost } from "node:timers/promises";
import { WorldProjectionBudgetError } from "../pipeline/frame";
import { OWNER } from "../../agents";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { canonicalJson } from "../../util/hash";
import type { WorldJob, WorldJobContext } from "../../serve/world-jobs";
import { scanMatches } from "../pipeline/collect";
import { newReadFrame, type ReadFrame } from "../pipeline/frame";
import { worldNamespace } from "../references";
import { basisIdentity, forecastBasis } from "./basis";
import { insertForecast, insertResolution, type ForecastRow } from "./store";
import { chooseResolution } from "./resolution";

function frame(ctx:WorldJobContext):ReadFrame {
  return newReadFrame({db:ctx.db,vaultPath:ctx.vaultPath,principal:OWNER,sourcePurpose:"derive"},worldNamespace(ctx.db,OWNER),{kind:"all"});
}
function cursor(ctx:WorldJobContext,name:string):string|null {
  const raw=ctx.db.query<{cursor:string},[string]>("SELECT cursor FROM rail_cursors WHERE rail='forecast' AND source_key=?").get(name)?.cursor;
  try { const parsed=JSON.parse(raw??"null");return typeof parsed==="string"&&parsed.length<=128?parsed:null; }
  catch { return null; }
}
function saveCursor(ctx:WorldJobContext,name:string,value:string|null,at:string):void {
  if(value!==null && (name==="discovery" ? ctx.db.query("SELECT 1 FROM semantic_handles WHERE handle_id=?").get(value) : ctx.db.query("SELECT 1 FROM world_forecasts WHERE forecast_id=?").get(value))===null)value=null;
  ctx.db.query("INSERT INTO rail_cursors(rail,source_key,cursor,updated_at) VALUES ('forecast',?,?,?) ON CONFLICT(rail,source_key) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at")
    .run(name,JSON.stringify(value),at);
}
/** Eight records per rail per pass. Each item commits independently and yields;
 * unresolved or over-budget prefixes cannot starve later commitments. */
export const forecastJob:WorldJob={id:"forecast",async run(ctx){
  const at=new Date(ctx.now()).toISOString(),start=performance.now();
  const stop=()=>ctx.stopRequested()||performance.now()-start>=10_000;
  if(stop())return;
  const pending=ctx.db.query<ForecastRow,[string]>("SELECT f.* FROM world_forecasts f WHERE f.forecast_id>? AND record_class='prediction' AND NOT EXISTS(SELECT 1 FROM world_forecast_resolutions r WHERE r.forecast_id=f.forecast_id) ORDER BY forecast_id LIMIT 8").all(cursor(ctx,"resolution")??"");
  const unresolved=pending.length===0 ? ctx.db.query<ForecastRow,[]>("SELECT f.* FROM world_forecasts f WHERE record_class='prediction' AND NOT EXISTS(SELECT 1 FROM world_forecast_resolutions r WHERE r.forecast_id=f.forecast_id) ORDER BY forecast_id LIMIT 8").all() : pending;
  if(unresolved.length===0)saveCursor(ctx,"resolution",null,at);
  for(const row of unresolved){
    if(stop())return;
    try { ctx.db.transaction(()=>{const at=new Date(ctx.now()).toISOString(),resolved=chooseResolution(frame(ctx),row,at);if(resolved!==null)insertResolution(ctx.db,row.forecast_id,resolved.status,resolved.observedAt,at,resolved.proofs);}).immediate(); }
    catch(error){if(!(error instanceof WorldProjectionBudgetError))throw error;}
    // A bounded failure is retried on the next scan cycle, never marked resolved.
    saveCursor(ctx,"resolution",row.forecast_id,at);await yieldToHost();
  }
  if(stop())return;
  const kind=activeWorldRegistry().kind("commitment");if(kind===undefined)return;
  const found=ctx.db.transaction(()=>scanMatches(frame(ctx),kind,"",cursor(ctx,"discovery"),8)).immediate();
  for(const match of found.found){
    if(stop())return;
    try { ctx.db.transaction(()=>{
      const current=frame(ctx),frozenAt=new Date(ctx.now()).toISOString();
      const clock=ctx.db.query<{last_sequence:number;last_recorded_at:string},[]>("SELECT last_sequence,last_recorded_at FROM claim_history_clock WHERE id=1").get()!;
      if(Date.parse(clock.last_recorded_at)>Date.parse(frozenAt))return;
      for(const basis of forecastBasis(current,match.handle)){
        if(Date.parse(basis.due)<=Date.parse(frozenAt))continue;
        for(const question of ["commitment_met_by_due",...(basis.conditions===null||!basis.awaitingInspection?[]:["next_independent_inspection_meets_criterion"])] as const){
          const basisKey=basisIdentity(basis);
          if(ctx.db.query("SELECT 1 FROM world_forecasts WHERE handle_id=? AND question=? AND record_class=? AND basis_key=?").get(match.handle,question,basis.class,basisKey)!==null)continue;
          insertForecast(ctx.db,{handle_id:match.handle,question:question as ForecastRow["question"],record_class:basis.class,frozen_at:frozenAt,frozen_sequence:clock.last_sequence,rule_version:"dependency-v1",
            probability:basis.probability,due_at:basis.due,conditions:basis.conditions===null?null:canonicalJson(basis.conditions),basis_key:basisKey},basis.proofs);
        }
      }
    }).immediate(); }catch(error){if(!(error instanceof WorldProjectionBudgetError))throw error;}
    saveCursor(ctx,"discovery",match.handle,at);await yieldToHost();
  }
  if(!stop())saveCursor(ctx,"discovery",found.resumeAfter,at);
}};
