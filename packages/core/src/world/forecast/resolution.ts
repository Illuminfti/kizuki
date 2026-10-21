import { rawSubjectRefKey } from "../../contracts/claim-v2";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { canonicalJson, sha256Hex } from "../../util/hash";
import { anchorOf, collectCard, COLLECTORS } from "../pipeline/collect";
import type { ReadFrame } from "../pipeline/frame";
import { identityReceiptCurrent } from "../identity-receipt";
import { collectOutcomeEntries, independentOutcomeRoots } from "../outcomes";
import { parseStoredOutcomeEvidence } from "../outcome-binding";
import type { ForecastConditions } from "./basis";
import { forecastInputs, type ForecastRow, type ResolutionRow } from "./store";
import { forecastProofCurrent, legacyProof, typedProof, type ForecastProof } from "./proof";
export interface ResolutionDecision { readonly status:Exclude<ResolutionRow["status"],"invalidated">;readonly observedAt:string;readonly proofs:readonly ForecastProof[] }
function conditionsOf(raw:string|null):ForecastConditions|null {
  if(raw===null)return null;
  let parsed:ForecastConditions;try{parsed=JSON.parse(raw);}catch{return null;}
  if(typeof parsed?.report!=="string"||parseStoredOutcomeEvidence("outcome.self_report",JSON.stringify(parsed.expected))===null)return null;
  return parsed;
}
export function chooseResolution(frame:ReadFrame,row:ForecastRow,at:string,admittedThrough?:number):ResolutionDecision|null {
  const db=frame.ctx.db,proofs=forecastInputs(db,row.forecast_id);
  if(proofs===null||!proofs.every(p=>forecastProofCurrent(frame,p)))return null;
  const anchor=anchorOf(db,row.handle_id);if(anchor===null)return null;
  let proposed:ResolutionDecision|null=null;
  const expected=conditionsOf(row.conditions);
  if(expected!==null){
    const collection=collectOutcomeEntries(frame,anchor.id,sha256Hex(rawSubjectRefKey(anchor)),undefined,admittedThrough);
    if(collection.overflow)return null;
    const report=collection.entries.find(e=>e.claim.claim_id===expected.report);
    if(report?.value===null||report===undefined||canonicalJson(report.value)!==canonicalJson(expected.expected))return null;
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
      return status==="resolved_met"&&observed<=due;
    });
    if(first?.value){
      const value=first.value,wrongVersion=canonicalJson(value.artifactVersion)!==canonicalJson(expected.expected.artifactVersion);
      const status=value.confounded||value.result==="inconclusive"?"censored":wrongVersion||value.result==="not_met"?"resolved_not_met":"resolved_met";
      const proof=legacyProof(frame,first.claim.claim_id);
      if(proof!==null && row.question==="next_independent_inspection_meets_criterion"){
        proposed={status,observedAt:first.observedAt!,proofs:[proof]};
      }
      if(proof!==null && row.question==="commitment_met_by_due" && row.due_at!==null){
        // The question's deadline is fixed. Late success cannot establish timely
        // completion. A later failed inspection cannot establish that the target
        // was never met before its deadline either.
        const observed=Date.parse(first.observedAt!),due=Date.parse(row.due_at);
        if(status==="resolved_met"&&observed<=due){
          proposed={status,observedAt:first.observedAt!,proofs:[proof]};
        }
      }
    }
  }
  if(row.question!=="commitment_met_by_due"||row.due_at===null)return proposed;
  const spec=activeWorldRegistry().kind("commitment")!;
  const collection=collectCard(frame,{anchor:row.handle_id,members:[row.handle_id],resolution:"distinct"},spec,COLLECTORS);
  if(collection===null||collection.overflow)return proposed;
  const statements=collection.items.filter(item=>item.semantic.perspective.holder===null&&item.semantic.predicate==="commitment.status"&&rawSubjectRefKey(item.semantic.subject)===rawSubjectRefKey(anchor)&&
    item.semantic.polarity==="positive"&&item.semantic.perspective.mode==="asserted"&&item.semantic.object.kind==="vocabulary"&&
    ["commitment/done","commitment/dropped"].includes(item.semantic.object.ref.id)&&
    item.supports.some(s=>s.row.support_origin==="native_owner"&&s.admission.epistemicKind==="owner_assertion"));
  for(const item of statements){
    const receipt=db.query<{receipt_id:string|null;asserted_at:string;producer:string},[string]>("SELECT receipt_id,asserted_at,producer FROM claims WHERE claim_id=?").get(item.claimId);
    if(receipt?.receipt_id==null||receipt.producer!=="owner"||Date.parse(receipt.asserted_at)<Date.parse(row.frozen_at)||Date.parse(receipt.asserted_at)>Date.parse(at)||!identityReceiptCurrent(db,item.claimId,receipt.receipt_id))continue;
    if(admittedThrough!==undefined&&db.query("SELECT 1 FROM (SELECT after_status,receipt_id FROM claim_lifecycle_history WHERE claim_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1) WHERE after_status='live' AND receipt_id=?").get(item.claimId,admittedThrough,receipt.receipt_id)===null)continue;
    if(item.semantic.object.kind!=="vocabulary")continue;
    const status=item.semantic.object.ref.id==="commitment/dropped"?"censored":item.semantic.temporal_basis!=="unknown"&&item.semantic.valid_from!==null&&Date.parse(item.semantic.valid_from)<=Date.parse(receipt.asserted_at)
      ?Date.parse(item.semantic.valid_from)<=Date.parse(row.due_at)?"resolved_met":"resolved_not_met":null;
    if(status!==null&&(proposed===null||Date.parse(receipt.asserted_at)<Date.parse(proposed.observedAt)))
      proposed={status,observedAt:receipt.asserted_at,proofs:[typedProof(frame,item)]};
  }
  return proposed;
}
