import { rawSubjectRefKey } from "../../contracts/claim-v2";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { deadlineInstant } from "./rules";
import { identityReceiptCurrent } from "../identity-receipt";
import { canonicalJson, sha256Hex } from "../../util/hash";
import { anchorOf, collectCard, COLLECTORS } from "../pipeline/collect";
import type { ReadFrame } from "../pipeline/frame";
import type { Eligible } from "../pipeline/eligible";
import { handleFor } from "../relation";
import { collectOutcomeEntries, independentOutcomeRoots } from "../outcomes";
import { outcomeArtifactBinding } from "../outcome-binding";
import { readWorldCard } from "../pipeline/read";
import { typedProof, legacyProof, type ForecastProof } from "./proof";
import type { StoredOutcomeEvidence } from "../outcome-binding";

export interface ForecastConditions {
  readonly report: string;
  readonly expected: StoredOutcomeEvidence;
}
export interface ForecastBasis {
  readonly due: string;
  readonly probability: number;
  readonly proofs: readonly ForecastProof[];
  readonly conditions: ForecastConditions | null;
  readonly class: "prediction" | "analysis";
  readonly awaitingInspection: boolean;
}
const asserted = (e:Eligible) => e.semantic.polarity==="positive" && e.semantic.perspective.mode==="asserted" && e.semantic.perspective.holder===null;
const sameSubject = (a:Eligible,b:ReturnType<typeof anchorOf>) => b!==null && rawSubjectRefKey(a.semantic.subject)===rawSubjectRefKey(b);
function collect(frame:ReadFrame,handle:string,kind:string):readonly Eligible[]|null {
  const spec=activeWorldRegistry().kind(kind);if(spec===undefined)return null;
  const found=collectCard(frame,{anchor:handle,members:[handle],resolution:"distinct"},spec,COLLECTORS);
  return found===null||found.overflow?null:found.items;
}
/** Fixed dependency-v1: 1/4 with a later-due prerequisite, otherwise the unfitted 1/2 baseline.
 * Neither number is a calibrated success rate. Missing or conflicting deadlines abstain. */
export function forecastBasis(frame:ReadFrame,handle:string):ForecastBasis[] {
  const anchor=anchorOf(frame.ctx.db,handle),items=collect(frame,handle,"commitment");
  if(anchor===null||items===null)return [];
  const own=items.filter(e=>sameSubject(e,anchor));
  // A forecast starts before the target is already settled. An attributed model
  // statement is not owner completion, even if it contains the word "done".
  if(own.some(e=>asserted(e)&&e.semantic.predicate==="commitment.status"&&e.semantic.object.kind==="vocabulary"&&["commitment/done","commitment/dropped"].includes(e.semantic.object.ref.id)&&
    e.supports.some(s=>s.row.support_origin==="native_owner"&&s.admission.epistemicKind==="owner_assertion")&&
    frame.ctx.db.query<{producer:string},[string]>("SELECT producer FROM claims WHERE claim_id=?").get(e.claimId)?.producer==="owner"&&
    identityReceiptCurrent(frame.ctx.db,e.claimId,frame.ctx.db.query<{receipt_id:string|null},[string]>("SELECT receipt_id FROM claims WHERE claim_id=?").get(e.claimId)?.receipt_id??"")))return [];
  const dues=own.filter(e=>e.semantic.predicate==="commitment.due"&&e.semantic.polarity==="positive"&&e.semantic.object.kind==="literal"&&e.semantic.perspective.holder===null);
  const actual=dues.filter(asserted),hypothetical=dues.filter(e=>e.semantic.perspective.mode==="hypothetical");
  const actualDates=new Set(actual.map(e=>e.semantic.object.kind==="literal"?deadlineInstant(e.semantic.object.value):null));
  const candidates:{dues:Eligible[];class:"prediction"|"analysis"}[]=[];
  if(actualDates.size===1&&!actualDates.has(null))candidates.push({dues:actual,class:"prediction"});
  for(const due of hypothetical.slice(0,8))candidates.push({dues:[due],class:"analysis"});
  const proofs=new Map<string,ForecastProof>();
  const pin=(e:Eligible)=>proofs.set(e.claimId,typedProof(frame,e));
  // Classification and exact deliverables are frozen; status is resolution evidence,
  // not an input feature. A new status cannot silently change the original probability.
  own.filter(e=>["world.kind","commitment.label","commitment.deliverable"].includes(e.semantic.predicate)).forEach(pin);
  let laterPrerequisite=false;
  const prerequisiteDates:string[]=[];
  for(const link of items.filter(e=>e.semantic.predicate==="situation.has_commitment"&&asserted(e)&&e.semantic.object.kind==="subject"&&rawSubjectRefKey(e.semantic.object.ref)===rawSubjectRefKey(anchor))){
    const owner=handleFor(frame.ctx.db,link.semantic.subject);if(owner===null)continue;
    const situation=collect(frame,owner,"situation");if(situation===null)return [];
    for(const relation of situation.filter(e=>e.semantic.predicate==="situation.requires"&&asserted(e)&&e.semantic.object.kind==="subject")){
      if(relation.semantic.object.kind!=="subject")continue;
      const prerequisite=handleFor(frame.ctx.db,relation.semantic.object.ref);if(prerequisite===null)return [];
      const rows=collect(frame,prerequisite,"commitment");if(rows===null)return [];
      const dates=rows.filter(e=>e.semantic.predicate==="commitment.due"&&asserted(e));
      const values=new Set(dates.map(e=>e.semantic.object.kind==="literal"?deadlineInstant(e.semantic.object.value):null));
      if(values.size!==1||values.has(null))return [];
      pin(link);pin(relation);rows.filter(e=>e.semantic.predicate==="world.kind").forEach(pin);dates.forEach(pin);
      prerequisiteDates.push([...values][0]!);
    }
  }
  const criteria=new Set(own.filter(e=>e.semantic.predicate==="commitment.deliverable"&&asserted(e)&&e.semantic.object.kind==="literal").map(e=>e.semantic.object.kind==="literal"?e.semantic.object.value:""));
  const artifacts=own.filter(e=>e.semantic.predicate==="commitment.deliverable"&&asserted(e)&&e.semantic.object.kind==="subject");
  let binding:string|undefined;
  if(artifacts.length===1&&artifacts[0]!.semantic.object.kind==="subject"){
    const raw=artifacts[0]!.semantic.object.ref,artifact=handleFor(frame.ctx.db,raw),card=artifact===null?null:readWorldCard(frame,artifact,"artifact_version");
    if(card===null||card.coverage.status!=="complete_for_query")return [];
    const artifactItems=collect(frame,artifact!,"artifact_version");if(artifactItems===null)return [];artifactItems.forEach(pin);
    binding=outcomeArtifactBinding(raw);
  }
  const outcomes=criteria.size===1&&artifacts.length<=1 ? collectOutcomeEntries(frame,anchor.id,sha256Hex(rawSubjectRefKey(anchor)),binding):null;
  const reports=outcomes?.overflow?[]:outcomes?.entries.filter(e=>e.stage.stage==="agent_reported"&&e.value!==null&&!e.value.confounded&&criteria.has(e.value.criterion))??[];
  const report=reports.length===1?reports[0]:undefined;
  const reportProof=report===undefined?null:legacyProof(frame,report.claim.claim_id);
  const awaitingInspection=report!==undefined && !(outcomes?.entries.some(e=>e.stage.stage==="observed"&&e.value!==null&&independentOutcomeRoots(report,e)&&e.value.task===report.value?.task&&e.value.attempt===report.value?.attempt&&e.value.criterion===report.value?.criterion&&e.value.environment===report.value?.environment&&e.value.assistance===report.value?.assistance)??false);
  const conditions=report?.value&&reportProof!==null?{report:report.claim.claim_id,expected:report.value}:null;
  if(reportProof!==null)proofs.set(reportProof.claim,reportProof);
  const alreadyMet=report?.value!==null&&report!==undefined&&outcomes?.entries.some(e=>e.stage.stage==="observed"&&e.value!==null&&!e.value.confounded&&e.value.result==="met"&&independentOutcomeRoots(report,e)&&
    e.value.task===report.value?.task&&e.value.attempt===report.value?.attempt&&e.value.criterion===report.value?.criterion&&e.value.environment===report.value?.environment&&e.value.assistance===report.value?.assistance&&canonicalJson(e.value.artifactVersion)===canonicalJson(report.value?.artifactVersion));
  if(alreadyMet)return [];
  return candidates.flatMap(candidate=>{
    const value=candidate.dues[0]?.semantic.object;
    const due=value?.kind==="literal"?deadlineInstant(value.value):null;if(due===null)return [];
    laterPrerequisite=prerequisiteDates.some(date=>Date.parse(date)>Date.parse(due));
    const pins=new Map(proofs);candidate.dues.forEach(e=>pins.set(e.claimId,typedProof(frame,e)));
    if(pins.size>256)return [];
    return [{awaitingInspection,due,probability:laterPrerequisite?0.25:0.5,proofs:[...pins.values()].sort((a,b)=>a.claim.localeCompare(b.claim)),conditions,class:candidate.class}];
  });
}
export function basisIdentity(basis:ForecastBasis):string {
  return sha256Hex(canonicalJson([basis.due,basis.class,basis.probability,basis.conditions,basis.proofs]));
}
