import { FORECAST_BASELINE, FORECAST_MINIMUM_RESOLVED, validateForecast, validateForecastScores, type Forecast, type ForecastRecord, type ForecastScores } from "../../contracts/forecast";
import type { WorldFrame, WorldWhen, WorldOpOutcome } from "../ops/types";
import { NOT_FOUND, coveredOutcome } from "../ops/outcome";
import { newReadFrame } from "../pipeline/frame";
import { coverageOf } from "../pipeline/assemble";
import { issueWorldRef } from "../references";
import { sealCard } from "../kinds/kit";
import { forecastInputs, validForecastRecord, forecastFingerprint, resolutionProofs, type ForecastRow, type ResolutionRow } from "./store";
import { forecastProofCurrent, forecastScopeSql, forecastProofScopeSql } from "./proof";

/** Read-only journal projection. It never creates, resolves or fits a prediction. */
export function readForecast(frame:WorldFrame,handle:string|null,when:WorldWhen,scores=false):WorldOpOutcome {
  if(when.valid.kind!=="all"||when.knownAt.kind==="snapshot")return {status:"unavailable",reason:"history"};
  const scope=forecastScopeSql(frame.ctx),read=newReadFrame(frame.ctx,frame.ns,when.valid,frame.dependencies);
  const cutoff=when.knownAt.kind==="time"?new Date(when.knownAt.at).toISOString():null;
  const rows=frame.ctx.db.query<ForecastRow,(string|number)[]>(`SELECT f.* FROM world_forecasts f WHERE ${handle===null?"1":"f.handle_id=?"}
    ${scores?"AND f.record_class='prediction'":""} ${cutoff===null?"":"AND julianday(f.frozen_at)<=julianday(?)"} AND ${scope.sql}
    ORDER BY f.frozen_at,f.forecast_id LIMIT 129`).all(...(handle===null?[]:[handle]),...(cutoff===null?[]:[cutoff]),...scope.bindings);
  read.stats.rowsExamined+=rows.length;
  const records:ForecastRecord[]=[];
  for(const row of rows.slice(0,128)){
    const inputs=forecastInputs(frame.ctx.db,row.forecast_id);if(inputs===null||!validForecastRecord(frame.ctx.db,row,inputs)||!inputs.every(p=>forecastProofCurrent(read,p)))continue;
    const allowed=forecastProofScopeSql(frame.ctx);
    const candidate=frame.ctx.db.query<ResolutionRow,(string|number)[]>(`SELECT status,resolved_at,recorded_at,recorded_sequence,proof FROM world_forecast_resolutions r
      WHERE forecast_id=? AND status<>'invalidated' ${cutoff===null?"":"AND julianday(recorded_at)<=julianday(?)"} AND NOT EXISTS(
        SELECT 1 FROM (SELECT value proof FROM json_each(r.proof)) pin LEFT JOIN claims base ON base.claim_id=json_extract(pin.proof,'$.claim')
        WHERE base.claim_id IS NULL OR COALESCE((${allowed.sql}),0)=0)`)
      .get(row.forecast_id,...(cutoff===null?[]:[cutoff]),...allowed.bindings);
    const candidateProofs=candidate===null?null:resolutionProofs(candidate);
    const resolved=candidateProofs!==null&&candidateProofs.every(p=>forecastProofCurrent(read,p))?candidate:null;
    const proofs=resolved===null?[]:candidateProofs!;
    const fingerprint=forecastFingerprint(frame.ctx.db,row.forecast_id,resolved!==null)!;
    frame.dependencies?.forecasts.set(row.forecast_id,{fingerprint,resolution:resolved!==null});
    records.push({subject:issueWorldRef(frame.ctx.db,frame.ns,"object",row.handle_id),question:row.question,method:"deterministic_dependency",class:row.record_class,
      frozenAt:row.frozen_at,inputs:inputs.map(p=>issueWorldRef(frame.ctx.db,frame.ns,"claim",p.claim)),probability:row.probability,
      status:resolved?.status==="invalidated"?"unresolved":resolved?.status??"unresolved",resolvedBy:proofs.map(p=>issueWorldRef(frame.ctx.db,frame.ns,"claim",p.claim))});
  }
  if(records.length===0&&!scores)return NOT_FOUND;
  const coverage=coverageOf(read,rows.length>128);
  if(!scores){const data:Forecast={baseline:FORECAST_BASELINE,schema:"kizuki.forecast/v1",records,coverage};return coveredOutcome(sealCard(data,validateForecast,"forecast"));}
  const resolved=records.filter(r=>r.status==="resolved_met"||r.status==="resolved_not_met");
  if(resolved.length<FORECAST_MINIMUM_RESOLVED)return {status:"unavailable",reason:"history"};
  const data:ForecastScores={baseline:FORECAST_BASELINE,schema:"kizuki.forecast-scores/v1",method:"deterministic_dependency",resolved:resolved.length,
    unresolved:records.filter(r=>r.status==="unresolved").length,censored:records.filter(r=>r.status==="censored").length,
    brier:resolved.reduce((sum,r)=>sum+(r.probability-(r.status==="resolved_met"?1:0))**2,0)/resolved.length,
    certainWrong:resolved.filter(r=>r.probability>=0.99&&r.status==="resolved_not_met"||r.probability<=0.01&&r.status==="resolved_met").length,
    cost:{predictions:records.length,retries:0,maintenance:0,unknown:[{metric:"retries",reason:"not_metered"},{metric:"maintenance",reason:"not_metered"},{metric:"cpu_time",reason:"not_metered"}]},
    usefulness:{status:"unavailable",reason:"insufficient_history"},coverage};
  return coveredOutcome(sealCard(data,validateForecastScores,"forecast-scores"));
}
