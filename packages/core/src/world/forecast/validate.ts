import { OWNER } from "../../agents";
import { newReadFrame } from "../pipeline/frame";
import { worldNamespace } from "../references";
import { chooseResolution } from "./resolution";
import { forecastProofCurrent } from "./proof";
import type { Database } from "bun:sqlite";
import { canonicalJson } from "../../util/hash";
import { isRfc3339 } from "../../util/time";
import { forecastInputs,validForecastRecord,resolutionProofs,type ForecastRow,type ResolutionRow } from "./store";
/** Archive corruption is refused. Inputs never get reconstructed from a later state. */
function validateJournal(db:Database):void {
  const invalidAdmission=db.query(`SELECT 1 FROM world_forecast_outcome_admissions a JOIN claims c USING(claim_id) CROSS JOIN claim_history_clock k
    WHERE c.is_world_typed<>0 OR c.status='purged' OR c.predicate NOT IN ('outcome.self_report','outcome.provider_ack','outcome.observation','outcome.review')
      OR a.sequence>k.last_sequence OR EXISTS(SELECT 1 FROM claim_lifecycle_history h WHERE h.sequence=a.sequence) LIMIT 1`).get();
  if(invalidAdmission!==null)throw new Error("invalid outcome admission position");
  for(const row of db.query<ForecastRow,[]>("SELECT * FROM world_forecasts").iterate()){
    const proofs=forecastInputs(db,row.forecast_id);
    if(proofs===null||!validForecastRecord(db,row,proofs))throw new Error("invalid frozen forecast journal");
    const resolution=db.query<ResolutionRow,[string]>("SELECT status,resolved_at,recorded_at,recorded_sequence,proof FROM world_forecast_resolutions WHERE forecast_id=?").get(row.forecast_id);
    if(resolution?.status==="invalidated"&&(resolution.resolved_at!==row.frozen_at||resolution.recorded_at!==row.frozen_at||resolution.recorded_sequence!==row.frozen_sequence))throw new Error("invalid erased forecast resolution");
    if(resolution!==null&&(!Number.isSafeInteger(resolution.recorded_sequence)||resolution.recorded_sequence<row.frozen_sequence||resolution.recorded_sequence>db.query<{last_sequence:number},[]>("SELECT last_sequence FROM claim_history_clock WHERE id=1").get()!.last_sequence||resolutionProofs(resolution)===null||!isRfc3339(resolution.resolved_at)||!isRfc3339(resolution.recorded_at)||Date.parse(resolution.recorded_at)<Date.parse(row.frozen_at)||Date.parse(resolution.resolved_at)>Date.parse(resolution.recorded_at)))throw new Error("invalid forecast resolution journal");
    if(resolution!==null&&resolution.status!=="invalidated"){
      const saved=resolutionProofs(resolution)!;
      const frame=newReadFrame({db,vaultPath:"",principal:OWNER,sourcePurpose:"derive"},worldNamespace(db,OWNER),{kind:"all"});
      if(!saved.every(proof=>forecastProofCurrent(frame,proof)))throw new Error("invalid forecast resolution evidence");
      const replay=chooseResolution(frame,row,resolution.recorded_at,resolution.recorded_sequence);
      if(replay===null||replay.status!==resolution.status||replay.observedAt!==resolution.resolved_at||canonicalJson(replay.proofs)!==canonicalJson(saved))throw new Error("invalid forecast resolution result");
    }
  }
}

export function validateForecastJournal(db:Database):void { db.transaction(()=>validateJournal(db)).immediate(); }
