import { setImmediate as yieldToHost } from "node:timers/promises";
import { WorldProjectionBudgetError } from "../pipeline/frame";
import { OWNER } from "../../agents";
import { rawSubjectRefKey } from "../../contracts/claim-v2";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { canonicalJson, sha256Hex } from "../../util/hash";
import type { WorldJob, WorldJobContext } from "../../serve/world-jobs";
import { anchorOf, scanMatches, collectCard, COLLECTORS } from "../pipeline/collect";
import { newReadFrame, type ReadFrame } from "../pipeline/frame";
import { worldNamespace } from "../references";
import { identityReceiptCurrent } from "../identity-receipt";
import { collectOutcomeEntries, independentOutcomeRoots } from "../outcomes";
import { parseStoredOutcomeEvidence } from "../outcome-binding";
import { basisIdentity, forecastBasis, type ForecastConditions } from "./basis";
import { forecastInputs, insertForecast, insertResolution, type ForecastRow } from "./store";
import { forecastProofCurrent, legacyProof, typedProof } from "./proof";

function frame(ctx:WorldJobContext):ReadFrame {
  return newReadFrame({db:ctx.db,vaultPath:ctx.vaultPath,principal:OWNER,sourcePurpose:"derive"},worldNamespace(ctx.db,OWNER),{kind:"all"});
}
function conditionsOf(raw:string|null):ForecastConditions|null {
  if(raw===null)return null;
  let parsed:ForecastConditions;try{parsed=JSON.parse(raw);}catch{return null;}
  if(typeof parsed?.report!=="string"||parseStoredOutcomeEvidence("outcome.self_report",JSON.stringify(parsed.expected))===null)return null;
  return parsed;
}
function resolve(frame:ReadFrame,row:ForecastRow,at:string):void {
  const db=frame.ctx.db,proofs=forecastInputs(db,row.forecast_id);
  if(proofs===null||!proofs.every(p=>forecastProofCurrent(frame,p)))return;
  const anchor=anchorOf(db,row.handle_id);if(anchor===null)return;
  const expected=conditionsOf(row.conditions);
  if(expected!==null){
    const collection=collectOutcomeEntries(frame,anchor.id,sha256Hex(rawSubjectRefKey(anchor)));
    if(collection.overflow)return;
    const report=collection.entries.find(e=>e.claim.claim_id===expected.report);
    if(report?.value===null||report===undefined||canonicalJson(report.value)!==canonicalJson(expected.expected))return;
    const matching=collection.entries.filter(e=>{
      const v=e.value,p=expected.expected;
      return e.stage.stage==="observed"&&v!==null&&e.observedAt!==null&&Date.parse(e.observedAt)>=Date.parse(row.frozen_at)&&Date.parse(e.observedAt)<=Date.parse(at)&&
        v.subjectRef===p.subjectRef&&v.task===p.task&&v.attempt===p.attempt&&v.criterion===p.criterion&&v.environment===p.environment&&v.assistance===p.assistance&&independentOutcomeRoots(report,e);
    }).sort((a,b)=>Date.parse(a.observedAt!)-Date.parse(b.observedAt!)||a.claim.claim_id.localeCompare(b.claim.claim_id));
    const verdict=(entry:typeof matching[number])=>entry.value!.confounded||entry.value!.result==="inconclusive"?"censored" as const:
      canonicalJson(entry.value!.artifactVersion)!==canonicalJson(expected.expected.artifactVersion)||entry.value!.result==="not_met"?"resolved_not_met" as const:"resolved_met" as const;
    const first=row.question==="next_independent_inspection_meets_criterion"?matching[0]:matching.find(entry=>{
      if(row.due_at===null)return false;
      const status=verdict(entry),observed=Date.parse(entry.observedAt!),due=Date.parse(row.due_at);
      return status==="resolved_met"&&observed<=due||status==="resolved_not_met"&&observed>=due;
    });
    if(first?.value){
      const value=first.value,wrongVersion=canonicalJson(value.artifactVersion)!==canonicalJson(expected.expected.artifactVersion);
      const status=value.confounded||value.result==="inconclusive"?"censored":wrongVersion||value.result==="not_met"?"resolved_not_met":"resolved_met";
      const proof=legacyProof(frame,first.claim.claim_id);
      if(proof!==null && row.question==="next_independent_inspection_meets_criterion"){
        insertResolution(db,row.forecast_id,status,first.observedAt!,at,[proof]);return;
      }
      if(proof!==null && row.question==="commitment_met_by_due" && row.due_at!==null){
        // The question's deadline is fixed. Late success cannot establish timely
        // completion; lack of an inspection never establishes failure.
        const observed=Date.parse(first.observedAt!),due=Date.parse(row.due_at);
        if(status==="censored"||status==="resolved_met"&&observed<=due||status==="resolved_not_met"&&observed>=due){
          insertResolution(db,row.forecast_id,status,first.observedAt!,at,[proof]);return;
        }
      }
    }
  }
  if(row.question!=="commitment_met_by_due"||row.due_at===null)return;
  const spec=activeWorldRegistry().kind("commitment")!;
  const collection=collectCard(frame,{anchor:row.handle_id,members:[row.handle_id],resolution:"distinct"},spec,COLLECTORS);
  if(collection===null||collection.overflow)return;
  const statements=collection.items.filter(item=>item.semantic.predicate==="commitment.status"&&rawSubjectRefKey(item.semantic.subject)===rawSubjectRefKey(anchor)&&
    item.semantic.polarity==="positive"&&item.semantic.perspective.mode==="asserted"&&item.semantic.object.kind==="vocabulary"&&
    ["commitment/done","commitment/dropped"].includes(item.semantic.object.ref.id)&&
    item.supports.some(s=>s.row.support_origin==="native_owner"&&s.admission.epistemicKind==="owner_assertion"));
  for(const item of statements){
    const receipt=db.query<{receipt_id:string|null;asserted_at:string},[string]>("SELECT receipt_id,asserted_at FROM claims WHERE claim_id=?").get(item.claimId);
    if(receipt?.receipt_id==null||Date.parse(receipt.asserted_at)<Date.parse(row.frozen_at)||!identityReceiptCurrent(db,item.claimId,receipt.receipt_id))continue;
    if(item.semantic.object.kind!=="vocabulary")continue;
    if(item.semantic.object.ref.id==="commitment/dropped")insertResolution(db,row.forecast_id,"censored",receipt.asserted_at,at,[typedProof(frame,item)]);
    else if(item.semantic.temporal_basis!=="unknown"&&item.semantic.valid_from!==null)
      insertResolution(db,row.forecast_id,Date.parse(item.semantic.valid_from)<=Date.parse(row.due_at)?"resolved_met":"resolved_not_met",item.semantic.valid_from,at,[typedProof(frame,item)]);
    return;
  }
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
    try { ctx.db.transaction(()=>resolve(frame(ctx),row,new Date(ctx.now()).toISOString())).immediate(); }
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
