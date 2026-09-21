import type { Database } from "bun:sqlite";
import { OWNER } from "../agents";
import { getClaim } from "../claims/store";
import { semanticKey } from "../claims/claim-v2-keys";
import { readClaimV2Semantic } from "../claims/claim-v2-commit";
import { rawSubjectNamespace } from "../contracts/claim-v2";
import type { Claim } from "../contracts/proposal";
import type { WorldAdmission } from "../contracts/world-admission";
import { canonicalJson, sha256Hex } from "../util/hash";
import { eligibleWorldClaim, type EligibleSupport, type ReadBudget } from "../world/projection";
import { authorizedSupportSql } from "../world/policy-sql";
import type { ServeContext } from "../serving/types";
import type { WorldClaimBasis } from "./world-receipt";
import { CanonWriteError } from "./errors";

const MAX_PAGE_CLAIMS=64;
export function worldAdmissionHash(admission:WorldAdmission):string { return sha256Hex(`kizuki.world-canon-admission/v1\0${canonicalJson(admission)}`); }
export function worldCanonPath(handle:string):string {
 if(!/^[0-9a-f]{32}$/.test(handle))throw new CanonWriteError("target_invalid","invalid world handle");
 return `auto/world/${handle}.md`;
}
export function worldClaimHandle(db:Database,claimId:string):string|null {
 const semantic=readClaimV2Semantic(db,claimId);if(semantic===null||semantic.discriminator!=="assertion")return null;
 return db.query<{handle_id:string},[string,string,string]>("SELECT handle_id FROM semantic_bindings WHERE raw_kind=? AND raw_namespace=? AND raw_id=?").get(semantic.subject.kind,rawSubjectNamespace(semantic.subject),semantic.subject.id)?.handle_id??null;
}
function context(db:Database):ServeContext {return {db,vaultPath:"",principal:OWNER,sourcePurpose:"derive"};}
function render(claim:Claim,support:EligibleSupport):Claim {
 return {...claim,body:support.admission.rendering.body,frontmatter:{},authority:support.admission.authority,confidence:support.admission.confidence,provenance:support.events.map(event=>event.event_id)};
}
export interface WorldMaterialization {
 readonly handle:string; readonly claims:readonly Claim[];readonly basis:readonly WorldClaimBasis[];
 readonly title:string;readonly pageType:"topic"|"project";
}
/** Select one complete admitted rendering per assertion; never pool partial or denied support. */
export function selectWorldMaterialization(db:Database,handle:string):WorldMaterialization|null {
 const ctx=context(db),permitted=authorizedSupportSql(ctx),budget:ReadBudget={bytes:0};
 const candidates=db.query<{claim_id:string},(string|number)[]>(`SELECT DISTINCT c.claim_id FROM claims c JOIN claim_v2_support s USING(claim_id) JOIN semantic_allocations a USING(support_key) JOIN semantic_bindings b USING(handle_id) JOIN claim_v2_semantics m ON m.claim_id=c.claim_id AND m.subject_kind=b.raw_kind AND m.subject_id=b.raw_id AND (b.raw_kind='occurrence' OR (json_extract(m.payload,'$.subject.namespace.connector_id')=json_extract(b.raw_namespace,'$.connector_id') AND json_extract(m.payload,'$.subject.namespace.source_key')=json_extract(b.raw_namespace,'$.source_key'))) WHERE c.is_world_typed=1 AND c.status='live' AND a.handle_id=? AND ${permitted.sql} ORDER BY c.claim_id LIMIT ?`).all(handle,...permitted.bindings,MAX_PAGE_CLAIMS+1);
 const claims:Claim[]=[],basis:WorldClaimBasis[]=[];let title="Knowledge record",pageType:"topic"|"project"="topic";
 for(const candidate of candidates) {
  if(worldClaimHandle(db,candidate.claim_id)!==handle)continue;
  const eligible=eligibleWorldClaim(ctx,candidate.claim_id,{kind:"all"},budget),support=eligible?.supports[0],claim=getClaim(db,candidate.claim_id);
  if(eligible===null||support===undefined||claim===null)continue;
  if(claims.length===MAX_PAGE_CLAIMS)throw new CanonWriteError("batch_too_large","world page exceeds its bounded materialization");
  const semantic=eligible.semantic;
  if(semantic.predicate==="world.kind"&&semantic.object.kind==="vocabulary"&&semantic.object.ref.id==="world/situation")pageType="project";
  if((semantic.predicate==="concept.label"||semantic.predicate==="situation.label")&&semantic.object.kind==="literal"&&typeof semantic.object.value==="string")title=semantic.object.value;
  claims.push(render(claim,support));basis.push({claim_id:claim.claim_id,semantic_key:semanticKey(semantic),supports:[{support_key:support.row.support_key,admission_hash:worldAdmissionHash(support.admission)}]});
 }
 return claims.length===0?null:{handle,claims,basis,title,pageType};
}
/** Exact selected historical support remains valid after supersession, but never after source loss. */
export function worldBasisAllowed(ctx:ServeContext,basis:readonly WorldClaimBasis[]|null,historical=false):boolean {
 if(basis===null)return true;
 try {
  const budget:ReadBudget={bytes:0};
  return basis.every(item=>{
   const eligible=eligibleWorldClaim(ctx,item.claim_id,{kind:"all"},budget,{...(historical?{historical:true as const}:{}),supportKeys:item.supports.map(support=>support.support_key)});
   return eligible!==null&&semanticKey(eligible.semantic)===item.semantic_key&&item.supports.every(expected=>eligible.supports.some(actual=>actual.row.support_key===expected.support_key&&worldAdmissionHash(actual.admission)===expected.admission_hash));
  });
 }catch{return false;}
}
export function assertWorldBasis(db:Database,basis:readonly WorldClaimBasis[]|null,historical=false):void {
 if(!worldBasisAllowed(context(db),basis,historical))throw new CanonWriteError("decision_stale","world support changed before canon admission");
}

/** Distinct bounded queue: neutral typed parents never enter the legacy materializer. */
export function pendingWorldCanonClaims(db:Database,limit=32):Claim[][] {
 const ctx=context(db),permitted=authorizedSupportSql(ctx);
 const ids=db.query<{claim_id:string},(string|number)[]>(`SELECT c.claim_id FROM claims c WHERE c.is_world_typed=1 AND c.status='live' AND c.receipt_id IS NULL AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) ORDER BY c.claim_id LIMIT ?`).all(...permitted.bindings,Math.min(limit,32)*MAX_PAGE_CLAIMS);
 const groups=new Map<string,Claim[]>();
 for(const {claim_id} of ids) {
  const handle=worldClaimHandle(db,claim_id),claim=getClaim(db,claim_id);if(handle===null||claim===null)continue;
  if(!groups.has(handle)&&groups.size===Math.min(limit,32))continue;
  const group=groups.get(handle)??[];
  if(group.length===MAX_PAGE_CLAIMS)continue;
  group.push(claim);groups.set(handle,group);
 }
 return [...groups.values()];
}
