import { readClaimV2Semantic } from "../../claims/claim-v2-commit";
import { rawSubjectRefKey } from "../../contracts/claim-v2";
import { anchorOf } from "../pipeline/collect";
import { supportAtSql } from "../known/cutoff";
import { deadlineInstant } from "./rules";
import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../util/hash";
import { ulid } from "../../util/ulid";
import { isRfc3339 } from "../../util/time";
import type { ForecastQuestion, ForecastStatus } from "../../contracts/forecast";
import { parseForecastProof, type ForecastProof } from "./proof";

export interface ForecastRow {
  forecast_id:string;handle_id:string;question:ForecastQuestion;record_class:"prediction"|"analysis";
  frozen_at:string;frozen_sequence:number;rule_version:"dependency-v1";probability:number;due_at:string|null;conditions:string|null;basis_key:string;basis_digest:string;
}
export interface ResolutionRow { status:Exclude<ForecastStatus,"unresolved">|"invalidated";resolved_at:string;recorded_at:string;proof:string }
export function forecastDigest(row: Omit<ForecastRow,"forecast_id"|"basis_digest">, proofs: readonly ForecastProof[]): string {
  return sha256Hex(canonicalJson([row,[...proofs].sort((a,b)=>a.claim.localeCompare(b.claim))]));
}
export function insertForecast(db:Database,row:Omit<ForecastRow,"forecast_id"|"basis_digest">,proofs:readonly ForecastProof[]):string {
  if(proofs.length===0||proofs.length>256||new Set(proofs.map(p=>p.claim)).size!==proofs.length||proofs.some(p=>parseForecastProof(p)===null))throw new Error("invalid forecast basis");
  const id=ulid(),digest=forecastDigest(row,proofs);
  db.query("INSERT INTO world_forecasts(forecast_id,handle_id,question,record_class,frozen_at,frozen_sequence,rule_version,probability,due_at,conditions,basis_key,basis_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id,row.handle_id,row.question,row.record_class,row.frozen_at,row.frozen_sequence,row.rule_version,row.probability,row.due_at,row.conditions,row.basis_key,digest);
  for(const proof of proofs)db.query("INSERT INTO world_forecast_inputs(forecast_id,claim_id,proof) VALUES (?,?,?)").run(id,proof.claim,canonicalJson(proof));
  return id;
}
export function forecastInputs(db:Database,id:string):ForecastProof[]|null {
  const rows=db.query<{claim_id:string;proof:string},[string]>("SELECT claim_id,proof FROM world_forecast_inputs WHERE forecast_id=? ORDER BY claim_id LIMIT 257").all(id);
  if(rows.length===0||rows.length>256)return null;
  const proofs:ForecastProof[]=[];
  for(const row of rows){let parsed:unknown;try{parsed=JSON.parse(row.proof);}catch{return null;}const proof=parseForecastProof(parsed);if(proof===null||proof.claim!==row.claim_id)return null;proofs.push(proof);}
  return proofs;
}
export function resolutionProofs(row:ResolutionRow):ForecastProof[]|null {
  let parsed:unknown;try{parsed=JSON.parse(row.proof);}catch{return null;}
  if(row.status==="invalidated")return row.proof==="[]"?[]:null;
  if(!Array.isArray(parsed)||parsed.length===0||parsed.length>256)return null;
  const values=parsed.map(parseForecastProof);return values.some(v=>v===null)?null:values as ForecastProof[];
}
export function insertResolution(db:Database,id:string,status:Exclude<ResolutionRow["status"],"invalidated">,observedAt:string,at:string,proofs:readonly ForecastProof[]):void {
  if(proofs.length===0||proofs.length>256||proofs.some(p=>parseForecastProof(p)===null))throw new Error("invalid forecast resolution");
  db.query("INSERT OR IGNORE INTO world_forecast_resolutions(forecast_id,status,resolved_at,recorded_at,proof) VALUES (?,?,?,?,?)").run(id,status,observedAt,at,canonicalJson([...proofs].sort((a,b)=>a.claim.localeCompare(b.claim))));
}
export function forecastFingerprint(db:Database,id:string,includeResolution=true):string|null {
  const row=db.query<ForecastRow,[string]>("SELECT * FROM world_forecasts WHERE forecast_id=?").get(id);
  if(row===null)return null;
  const resolution=includeResolution?db.query<ResolutionRow,[string]>("SELECT status,resolved_at,recorded_at,proof FROM world_forecast_resolutions WHERE forecast_id=?").get(id):null;
  return sha256Hex(canonicalJson([row,resolution]));
}
/** Check the declared frozen prefix and replay the fixed rule from only its saved inputs. */
export function validForecastRecord(db:Database,row:ForecastRow,proofs:readonly ForecastProof[]):boolean {
  const {forecast_id:_id,basis_digest:digest,...record}=row;
  if(forecastDigest(record,proofs)!==digest||!isRfc3339(row.frozen_at)||!Number.isSafeInteger(row.frozen_sequence))return false;
  const anchor=anchorOf(db,row.handle_id);if(anchor===null)return false;
  const cutoff={at:row.frozen_at,sequence:row.frozen_sequence};
  for(const proof of proofs){
    if(proof.kind==="typed"){
      const rowCount=db.query<{n:number},[string]>(`SELECT count(*) n FROM claim_v2_support s WHERE s.support_key IN (SELECT value FROM json_each(?)) AND ${supportAtSql(cutoff)}`)
        .get(JSON.stringify(proof.supports))?.n;
      if(rowCount!==proof.supports.length)return false;
      const state=db.query<{recorded_at:string;after_status:string},[string,number]>("SELECT recorded_at,after_status FROM claim_lifecycle_history WHERE claim_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1").get(proof.claim,row.frozen_sequence);
      if(state===null||state.after_status!=="live"||Date.parse(state.recorded_at)>Date.parse(row.frozen_at))return false;
    } else {
      const claim=db.query<{asserted_at:string},[string]>("SELECT asserted_at FROM claims WHERE claim_id=? AND is_world_typed=0").get(proof.claim);
      if(claim===null||Date.parse(claim.asserted_at)>Date.parse(row.frozen_at))return false;
    }
  }
  const claims=proofs.filter(p=>p.kind==="typed").map(p=>readClaimV2Semantic(db,p.claim)).filter(c=>c?.discriminator==="assertion");
  const key=rawSubjectRefKey(anchor);
  const ownDue=claims.some(c=>c!==null&&c.discriminator==="assertion"&&rawSubjectRefKey(c.subject)===key&&c.predicate==="commitment.due"&&c.object.kind==="literal"&&deadlineInstant(c.object.value)===row.due_at&&c.polarity==="positive"&&c.perspective.holder===null&&c.perspective.mode===(row.record_class==="analysis"?"hypothetical":"asserted"));
  if(!ownDue||row.due_at===null)return false;
  const owners=new Set(claims.flatMap(c=>c?.discriminator==="assertion"&&c.predicate==="situation.has_commitment"&&c.polarity==="positive"&&c.perspective.mode==="asserted"&&c.object.kind==="subject"&&rawSubjectRefKey(c.object.ref)===key?[rawSubjectRefKey(c.subject)]:[]));
  const prerequisites=new Set(claims.flatMap(c=>c?.discriminator==="assertion"&&c.predicate==="situation.requires"&&c.polarity==="positive"&&c.perspective.mode==="asserted"&&owners.has(rawSubjectRefKey(c.subject))&&c.object.kind==="subject"?[rawSubjectRefKey(c.object.ref)]:[]));
  const late=claims.some(c=>c?.discriminator==="assertion"&&c.predicate==="commitment.due"&&c.polarity==="positive"&&c.perspective.mode==="asserted"&&prerequisites.has(rawSubjectRefKey(c.subject))&&c.object.kind==="literal"&&Date.parse(deadlineInstant(c.object.value)??"")>Date.parse(row.due_at!));
  if(row.probability!==(late?0.25:0.5))return false;
  let conditions:unknown;try{conditions=row.conditions===null?null:JSON.parse(row.conditions);}catch{return false;}
  return row.basis_key===sha256Hex(canonicalJson([row.due_at,row.record_class,row.probability,conditions,[...proofs].sort((a,b)=>a.claim.localeCompare(b.claim))]));
}
/** Archive corruption is refused. Inputs never get reconstructed from a later state. */
export function validateForecastJournal(db:Database):void {
  for(const row of db.query<ForecastRow,[]>("SELECT * FROM world_forecasts").iterate()){
    const proofs=forecastInputs(db,row.forecast_id);
    if(proofs===null||!validForecastRecord(db,row,proofs))throw new Error("invalid frozen forecast journal");
    const resolution=db.query<ResolutionRow,[string]>("SELECT status,resolved_at,recorded_at,proof FROM world_forecast_resolutions WHERE forecast_id=?").get(row.forecast_id);
    if(resolution?.status==="invalidated"&&(resolution.resolved_at!==row.frozen_at||resolution.recorded_at!==row.frozen_at))throw new Error("invalid erased forecast resolution");
    if(resolution!==null&&(resolutionProofs(resolution)===null||!isRfc3339(resolution.resolved_at)||!isRfc3339(resolution.recorded_at)||Date.parse(resolution.recorded_at)<Date.parse(row.frozen_at)||Date.parse(resolution.resolved_at)>Date.parse(resolution.recorded_at)))throw new Error("invalid forecast resolution journal");
  }
}
