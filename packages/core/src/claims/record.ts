import type { Database } from "bun:sqlite";
import type { Claim } from "../contracts/proposal";
import { CLAIM_MEANING_SCHEMA, validateClaimMeaning, type ClaimMeaning, type ClaimV2Object } from "../contracts/claim-v2";
import type { SourceReadScope } from "../ledger/source-grants";
import { canonicalJson, sha256Hex } from "../util/hash";
import { isRfc3339 } from "../util/time";
import { tableExists } from "../ledger/schema";
import { isSingleValuedPredicate } from "./predicates";
import { boundedClaimRows, decodeClaimV1, invalidStoredClaim, storedFrontmatter, storedStringArray, type ClaimRow } from "./record-storage";
import { anchorFits, decodeOccurrence, decodeSupport, endpointKey, meaningEndpoints, occurrenceId,
  readSupportEvent, semanticKey, supportEligible, supportKey, type ClaimSupportAdmission, type ClaimOccurrence } from "./support";

export type ClaimV1 = Claim;
export interface ClaimV2 extends Omit<Claim,"schema"|"valid_from"|"object"|"status"> {
  schema:"kizuki.claim/v2";
  status:Exclude<Claim["status"],"purged">;
  object:ClaimV2Object|null;
  valid_from:string|null;
  meaning:ClaimMeaning;
  support:readonly {support_key:string;admission:ClaimSupportAdmission}[];
}
export interface PurgedClaimV2 {
  schema:"kizuki.claim/v2";
  representation:"purged";
  claim_id:string;
  status:"purged";
  purge_ref:string;
  at:string;
  sensitivity:"private";
}
export type ClaimRecord = ClaimV1 | ClaimV2 | PurgedClaimV2;
export const MAX_CLAIM_SUPPORTS = 256;
export const MAX_SUPPORT_BYTES = 8_388_608;
export function richConflictKey(meaning:ClaimMeaning):string|null {
  if(meaning.discriminator==="identity_control") return null;
  return sha256Hex(`kizuki.claim-conflict-key/v1\0${canonicalJson({schema:CLAIM_MEANING_SCHEMA,
    subject:meaning.subject,predicate:meaning.predicate,perspective:meaning.perspective,context:meaning.context,
    ...(!isSingleValuedPredicate(meaning.predicate)?{object:meaning.object}:{})})}`);
}
/** Closed child payload metadata and UTF-8 admission before JSON parsing. */
export function childPayload(db:Database,table:"claim_v2_semantics"|"claim_v2_support"|"claim_occurrences",
  key:string,id:string,field:"payload"|"admission",maxBytes:number):string|null {
  using meta=db.prepare<{kind:string;bytes:number},[string]>(`SELECT typeof(${field}) AS kind,octet_length(${field}) AS bytes FROM ${table} WHERE ${key}=?`);
  const size=meta.get(id);
  if(size===null) return null;
  if(size.kind!=="text" || size.bytes>maxBytes) return invalidStoredClaim();
  using query=db.prepare<{value:Uint8Array},[string]>(`SELECT CAST(${field} AS BLOB) AS value FROM ${table} WHERE ${key}=?`);
  try { return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(query.get(id)!.value); }
  catch { return invalidStoredClaim(); }
}
export function getOccurrence(db:Database,id:string):{occurrence_id:string;label:string;occurrence:ClaimOccurrence}|null {
  return db.transaction(()=>{
    const payload=childPayload(db,"claim_occurrences","occurrence_id",id,"payload",16384);
    if(payload===null) return null;
    using metadata=db.prepare<{valid:number},[string]>("SELECT (octet_length(label) BETWEEN 1 AND 512 AND octet_length(event_id)=26) AS valid FROM claim_occurrences WHERE occurrence_id=?");
    if(metadata.get(id)?.valid!==1) return invalidStoredClaim();
    using query=db.prepare<{event_id:string;label:Uint8Array},[string]>("SELECT event_id,CAST(label AS BLOB) AS label FROM claim_occurrences WHERE occurrence_id=?");
    const row=query.get(id)!;
    const occurrence=decodeOccurrence(payload);
    const event=readSupportEvent(db,occurrence.event.event_id);
    if(row.event_id!==occurrence.event.event_id || event===null || occurrenceId(occurrence,event)!==id ||
      !anchorFits(event,{event_id:event.event_id,start_utf16:occurrence.start_utf16,end_utf16:occurrence.end_utf16})) return invalidStoredClaim();
    let label:string;
    try {label=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(row.label);} catch {return invalidStoredClaim();}
    return {occurrence_id:id,label,occurrence};
  }).deferred();
}
export function supportIndexRows(admission:ClaimSupportAdmission):{event_id:string;start_utf16:number;end_utf16:number;role:string;ref_kind:string;ref_id:string}[] {
  return [
    ...admission.anchors.map(a=>({...a,role:"assertion",ref_kind:"",ref_id:""})),
    ...admission.attribution_anchors.map(a=>({...a,role:"attribution",ref_kind:"",ref_id:""})),
    ...admission.endpoints.flatMap(e=>e.anchors.map(a=>({...a,role:e.role,ref_kind:e.ref.kind,ref_id:e.ref.id}))),
  ].sort((a,b)=>canonicalJson(a)<canonicalJson(b)?-1:1);
}
export function readClaimSupports(db:Database,claimId:string,key:string,meaning:ClaimMeaning):ClaimV2["support"] {
  const supports:{support_key:string;admission:ClaimSupportAdmission}[]=[];
  let after="",bytes=0;
  using page=db.prepare<{support_key:string;bytes:number},[string,string]>(`SELECT support_key,octet_length(admission) AS bytes FROM claim_v2_support
    WHERE claim_id=? AND support_key>? ORDER BY support_key LIMIT 32`);
  for(;;) {
    const rows=page.all(claimId,after);
    if(rows.length===0) break;
    if(supports.length+rows.length>MAX_CLAIM_SUPPORTS || (bytes+=rows.reduce((n,row)=>n+row.bytes,0))>MAX_SUPPORT_BYTES) return invalidStoredClaim();
    for(const row of rows) {
      const admission=decodeSupport(childPayload(db,"claim_v2_support","support_key",row.support_key,"admission",262144)!);
      if(supportKey(key,admission)!==row.support_key ||
        canonicalJson(admission.endpoints.map(({role,ref})=>({role,ref})))!==canonicalJson(meaningEndpoints(meaning))) return invalidStoredClaim();
      using eventIndex=db.prepare<{event_id:string},[string]>("SELECT event_id FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id LIMIT 9");
      if(canonicalJson(eventIndex.all(row.support_key).map(e=>e.event_id))!==canonicalJson(admission.events.map(e=>e.event_id))) return invalidStoredClaim();
      using anchors=db.prepare<ReturnType<typeof supportIndexRows>[number],[string]>(`SELECT event_id,start_utf16,end_utf16,role,ref_kind,ref_id FROM claim_v2_support_anchors WHERE support_key=? LIMIT 257`);
      const indexed=anchors.all(row.support_key).sort((a,b)=>canonicalJson(a)<canonicalJson(b)?-1:1);
      if(canonicalJson(indexed)!==canonicalJson(supportIndexRows(admission))) return invalidStoredClaim();
      const events=new Map(admission.events.map(e=>[e.event_id,readSupportEvent(db,e.event_id)]));
      for(const span of [...admission.anchors,...admission.attribution_anchors,...admission.endpoints.flatMap(e=>e.anchors)]) {
        const event=events.get(span.event_id);
        if(event===null || event===undefined || !anchorFits(event,span)) return invalidStoredClaim();
      }
      for(const endpoint of admission.endpoints) {
        if(endpoint.ref.kind==="occurrence") {
          const occurrence=getOccurrence(db,endpoint.ref.id);
          if(occurrence===null || !endpoint.anchors.some(a=>a.event_id===occurrence.occurrence.event.event_id &&
            a.start_utf16===occurrence.occurrence.start_utf16 && a.end_utf16===occurrence.occurrence.end_utf16)) return invalidStoredClaim();
        } else if(!endpoint.anchors.some(a=>events.get(a.event_id)?.subjects.some(s=>s.subject_id===endpoint.ref.id))) return invalidStoredClaim();
        if(["holder","speaker","addressee"].includes(endpoint.role) && !endpoint.anchors.every(a=>admission.attribution_anchors.some(b=>canonicalJson(a)===canonicalJson(b)))) return invalidStoredClaim();
      }
      supports.push({support_key:row.support_key,admission}); after=row.support_key;
    }
  }
  if(supports.length===0) return invalidStoredClaim();
  return supports;
}
function decodeRecord(db:Database,row:ClaimRow):ClaimRecord {
  if(row.claim_schema==="kizuki.claim/v1" || row.claim_schema===undefined) return decodeClaimV1(row);
  if(row.claim_schema!=="kizuki.claim/v2") return invalidStoredClaim();
  if(row.status==="purged") {
    using children=db.prepare("SELECT 1 FROM claim_v2_semantics WHERE claim_id=? UNION ALL SELECT 1 FROM claim_v2_support WHERE claim_id=? LIMIT 1");
    if(!row.purge_ref || !isRfc3339(row.retracted_at) || children.get(row.claim_id,row.claim_id)!==null ||
      row.body!=="" || row.subject!==null || row.provenance!=="[]" || row.subjects!=="[]" || row.frontmatter!=="{}" || row.claim_key!==null ||
      row.object!==null || row.predicate!==null || row.valid_from!==null || row.valid_to!==null || row.sensitivity!=="private" ||
      row.body_hash!==sha256Hex(`kizuki.claim-purged/v1\0${row.claim_id}\0${row.purge_ref}`)) return invalidStoredClaim();
    using proof=db.prepare("SELECT 1 FROM purge_journal WHERE receipt_id=?");
    if(proof.get(row.purge_ref)===null) return invalidStoredClaim();
    return {schema:"kizuki.claim/v2",representation:"purged",claim_id:row.claim_id,status:"purged",purge_ref:row.purge_ref,at:row.retracted_at,sensitivity:"private"};
  }
  const payload=childPayload(db,"claim_v2_semantics","claim_id",row.claim_id,"payload",262144);
  if(payload===null) return invalidStoredClaim();
  let parsed:unknown;
  try {parsed=JSON.parse(payload);} catch {return invalidStoredClaim();}
  const result=validateClaimMeaning(parsed);
  if(!result.ok) return invalidStoredClaim();
  const meaning=result.value;
  using keys=db.prepare<{semantic_key:string;conflict_key:string|null},[string]>("SELECT semantic_key,conflict_key FROM claim_v2_semantics WHERE claim_id=?");
  const key=keys.get(row.claim_id)!;
  const subject=meaning.discriminator==="assertion"?meaning.subject.id:null;
  const predicate=meaning.discriminator==="assertion"?meaning.predicate:null;
  const basis=meaning.discriminator==="assertion"?meaning.temporal_basis:"unknown";
  if(key.semantic_key!==semanticKey(meaning) || key.conflict_key!==richConflictKey(meaning) || row.claim_key!==key.conflict_key ||
    row.subject!==subject || row.predicate!==predicate || row.object!==null || row.temporal_basis!==basis || row.purge_ref!==null ||
    row.valid_from!==(meaning.discriminator==="assertion"?meaning.valid_from:null) ||
    (basis==="unknown" && row.valid_to!==null)) return invalidStoredClaim();
  const supports=readClaimSupports(db,row.claim_id,key.semantic_key,meaning);
  const provenance=storedStringArray(row.provenance),subjects=storedStringArray(row.subjects);
  if(canonicalJson([...new Set(supports.flatMap(s=>s.admission.events.map(e=>e.event_id)))].sort())!==canonicalJson(provenance) ||
    canonicalJson([...new Set(meaningEndpoints(meaning).map(e=>e.ref.id))].sort())!==canonicalJson(subjects)) return invalidStoredClaim();
  const {claim_schema:_schema,temporal_basis:_basis,purge_ref:_purge,...common}=row;
  return {...common,schema:"kizuki.claim/v2",status:row.status as ClaimV2["status"],
    sensitivity:(row.sensitivity??"private") as Claim["sensitivity"],frontmatter:storedFrontmatter(row.frontmatter),
    object:meaning.discriminator==="assertion"?meaning.object:null,provenance,subjects,meaning,support:supports};
}
export function getClaimRecord(db:Database,id:string):ClaimRecord|null {
  if(!tableExists(db,"claims")) return null;
  return db.transaction(()=>{
    const row=boundedClaimRows(db,"WHERE claim_id=?",[id],1)[0];
    return row===undefined?null:decodeRecord(db,row);
  }).deferred();
}
export function listClaimRecords(db:Database,opts:{subject?:string;claim_key?:string;limit?:number;filter?:(claim:ClaimRecord)=>boolean}={}):ClaimRecord[] {
  if(!tableExists(db,"claims")) return [];
  const limit=opts.limit??200;
  if(!Number.isSafeInteger(limit) || limit<1 || limit>10000) throw new TypeError("claim record limit must be 1..10000");
  return db.transaction(()=>{
    const out:ClaimRecord[]=[];
    let after="";
    for(;;) {
      const clauses=["claim_id>?"],args:(string|number)[]=[after];
      if(opts.subject!==undefined){clauses.push("subject=?");args.push(opts.subject);}
      if(opts.claim_key!==undefined){clauses.push("claim_key=?");args.push(opts.claim_key);}
      const rows=boundedClaimRows(db,`WHERE ${clauses.join(" AND ")} ORDER BY claim_id`,args);
      if(rows.length===0) return out;
      for(const row of rows) {
        after=row.claim_id;
        const claim=decodeRecord(db,row);
        if(opts.filter!==undefined && !opts.filter(claim)) continue;
        out.push(claim); if(out.length>=limit) return out;
      }
    }
  }).deferred();
}
/** Revocation removes complete admissions from eligibility, never their payload. */
export function eligibleClaimSupport(db:Database,claim:ClaimV2,scope:SourceReadScope):ClaimV2["support"] {
  return claim.support.filter(s=>supportEligible(db,s.admission,scope));
}
