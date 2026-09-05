import type { Database } from "bun:sqlite";
import type { Claim, AuthorityTier, ClaimStatus } from "../contracts/proposal";
import { isAuthorityTier, isClaimStatus } from "../contracts/proposal";
import { compareRfc3339 } from "../agents/time";
import { isRfc3339 } from "../util/time";
import { ulid } from "../util/ulid";
import { tableExists } from "../ledger/schema";
import { invalidStoredClaim } from "./record-storage";

export const CLAIM_HISTORY_SCHEMA = "kizuki.claim-transition/v1" as const;
export const CLAIM_HISTORY_PURGED_SCHEMA = "kizuki.claim-transition-purged/v1" as const;
export const HISTORY_OPERATIONS = ["upgrade_baseline","assertion","support_addition","supersession","retraction","revert","reinstate","materialization","projection"] as const;
export type HistoryOperation = typeof HISTORY_OPERATIONS[number];
export interface ClaimProjection {
  status:ClaimStatus; confidence:number; authority:AuthorityTier; valid_from:string|null;
  valid_to:string|null; retracted_at:string|null; superseded_by:string|null;
  corroboration:number; last_confirmed_at:string|null; receipt_id:string|null;
  provenance:string[];
}
export interface ClaimTransition {
  sequence:number; transition_id:string; claim_id:string; schema:typeof CLAIM_HISTORY_SCHEMA;
  operation:HistoryOperation; at:string; before:ClaimProjection|null; after:ClaimProjection;
  receipt_id:string|null;
}
export function claimProjection(claim:Pick<Claim,keyof ClaimProjection> | ClaimProjection):ClaimProjection {
  return {status:claim.status,confidence:claim.confidence,authority:claim.authority,
    valid_from:claim.valid_from,valid_to:claim.valid_to,retracted_at:claim.retracted_at,
    superseded_by:claim.superseded_by,corroboration:claim.corroboration,
    last_confirmed_at:claim.last_confirmed_at,receipt_id:claim.receipt_id,provenance:[...claim.provenance]};
}
export function transitionIntegrity(value:Record<string,unknown>):string {
  return new Bun.CryptoHasher("sha256").update(String(value.schema)).update("\0")
    .update(JSON.stringify(value)).digest("hex");
}
function parseProjection(raw:string):ClaimProjection {
  let p:unknown;
  try { p=JSON.parse(raw); } catch { return invalidStoredClaim(); }
  if(p===null || typeof p!=="object" || Array.isArray(p)) return invalidStoredClaim();
  const value=p as ClaimProjection;
  if(Object.keys(value).sort().join(",")!=="authority,confidence,corroboration,last_confirmed_at,provenance,receipt_id,retracted_at,status,superseded_by,valid_from,valid_to" ||
    !isClaimStatus(value.status) || !isAuthorityTier(value.authority) || !Number.isFinite(value.confidence) || value.confidence<0 || value.confidence>1 ||
    !Number.isSafeInteger(value.corroboration) || value.corroboration<0 ||
    [value.valid_from,value.valid_to,value.retracted_at,value.last_confirmed_at].some(t=>t!==null && !isRfc3339(t)) ||
    [value.receipt_id,value.superseded_by].some(id=>id!==null && (typeof id!=="string" || id.length===0 || id.length>128)) ||
    !Array.isArray(value.provenance) || value.provenance.length>4096 || !value.provenance.every(id=>typeof id==="string" && id.length>0 && id.length<=128)) return invalidStoredClaim();
  return value;
}
/** A child of the caller's transaction; never commits a partial transition. */
export function appendClaimTransition(db:Database, claimId:string, operation:HistoryOperation, at:string,
  before:ClaimProjection|null, after:ClaimProjection, receiptId:string|null=null):void {
  if(!tableExists(db,"claim_history")) return; // historical schema constructors only
  if(!db.inTransaction || !isRfc3339(at)) return invalidStoredClaim();
  const value={schema:CLAIM_HISTORY_SCHEMA,transition_id:ulid(),claim_id:claimId,operation,at,
    before:before===null?null:claimProjection(before),after:claimProjection(after),receipt_id:receiptId};
  using insert=db.prepare(`INSERT INTO claim_history(transition_id,claim_id,schema,operation,at,before_projection,after_projection,receipt_id,integrity)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  insert.run(value.transition_id,claimId,value.schema,operation,at,
      value.before===null?null:JSON.stringify(value.before),JSON.stringify(value.after),receiptId,transitionIntegrity(value));
}
export function readClaimHistory(db:Database, claimId:string):ClaimTransition[] {
  if(!tableExists(db,"claim_history")) return [];
  return db.transaction(()=>{
    const history:ClaimTransition[]=[];
    let sequence=0;
    for(;;) {
      const sizes=db.query<{sequence:number;bytes:number},[string,number]>(`SELECT sequence,
        coalesce(octet_length(before_projection),0)+coalesce(octet_length(after_projection),0) AS bytes
        FROM claim_history WHERE claim_id=? AND sequence>? ORDER BY sequence LIMIT 32`).all(claimId,sequence);
      if(sizes.length===0) break;
      if(sizes.some(row=>row.bytes>524288) || history.length+sizes.length>4096) return invalidStoredClaim();
      for(const size of sizes) {
        const row=db.query<{sequence:number;transition_id:string;claim_id:string;schema:string;operation:HistoryOperation;at:string;before_projection:string|null;after_projection:string|null;receipt_id:string|null;purge_ref:string|null;integrity:string},[number]>("SELECT * FROM claim_history WHERE sequence=?").get(size.sequence);
        if(row===null || row.schema!==CLAIM_HISTORY_SCHEMA || row.purge_ref!==null || row.after_projection===null || !HISTORY_OPERATIONS.includes(row.operation) || !isRfc3339(row.at)) return invalidStoredClaim();
        const value={schema:CLAIM_HISTORY_SCHEMA,transition_id:row.transition_id,claim_id:row.claim_id,operation:row.operation,at:row.at,
          before:row.before_projection===null?null:parseProjection(row.before_projection),after:parseProjection(row.after_projection),receipt_id:row.receipt_id};
        if(transitionIntegrity(value)!==row.integrity) return invalidStoredClaim();
        const previous=history.at(-1);
        if(previous!==undefined && JSON.stringify(previous.after)!==JSON.stringify(value.before)) return invalidStoredClaim();
        if(previous===undefined && value.before!==null) return invalidStoredClaim();
        history.push({sequence:row.sequence,...value}); sequence=row.sequence;
      }
    }
    return history;
  }).deferred();
}
export type TransactionView = {state:"known";projection:ClaimProjection;sequence:number} |
  {state:"not_asserted"} | {state:"unknown";reason:"before_upgrade_baseline"|"history_unavailable"|"clock_order"};
export function claimAtTransaction(db:Database,claimId:string,at:string):TransactionView {
  if(!isRfc3339(at)) throw new TypeError("transaction time must be RFC3339");
  const history=readClaimHistory(db,claimId);
  const first=history[0];
  if(first===undefined) return {state:"unknown",reason:"history_unavailable"};
  if(history.some((item,index)=>index>0 && compareRfc3339(item.at,"at",history[index-1]!.at,"at")<0)) return {state:"unknown",reason:"clock_order"};
  if(compareRfc3339(at,"at",first.at,"baseline")<0) return first.operation==="upgrade_baseline"?
    {state:"unknown",reason:"before_upgrade_baseline"}:{state:"not_asserted"};
  const selected=history.filter(item=>compareRfc3339(item.at,"at",at,"as_of_transaction")<=0).at(-1)!;
  return {state:"known",projection:selected.after,sequence:selected.sequence};
}
