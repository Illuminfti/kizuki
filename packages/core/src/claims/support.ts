import type { Database } from "bun:sqlite";
import type { ClaimMeaning, RawSubjectRef } from "../contracts/claim-v2";
import type { TextAnchor } from "../contracts/producer-v2";
import { EVENT_LIMITS, type CaptureEvent } from "../contracts/event";
import { isAuthorityTier, isProducer, type AuthorityTier, type CanonicalProducer } from "../contracts/proposal";
import type { Sensitivity } from "../agents/types";
import { canonicalJson, sha256Hex } from "../util/hash";
import { cloneExactJson, isPlainObject, utf8ByteLength } from "../util/validate";
import { isVisibleIdentifier } from "../util/opaque-identifier";
import { isRfc3339 } from "../util/time";
import { isUlid } from "../util/ulid";
import { eventFromRow, type EventRow } from "../ledger/event-record";
import { validateEventOrigin } from "../ledger/event-origin";
import { sourceEventsAllowed, type SourceReadScope } from "../ledger/source-grants";
import { invalidStoredClaim } from "./record-storage";

export const CLAIM_SUPPORT_SCHEMA = "kizuki.claim-support/v1" as const;
export const CLAIM_OCCURRENCE_SCHEMA = "kizuki.claim-occurrence/v1" as const;
export type SupportSource = {
  kind:"enrolled"; source_key:string; binding_revision:number; binding_digest:string;
  checked_revision:number; checked_digest:string;
} | {kind:"native"; request_digest:string} | {kind:"legacy"};
export interface SupportEvent {
  event_id:string; connector_id:string; source:SupportSource;
  content_hash_version:1|2; content_hash:string; text_hash:string; origin_binding:string;
}
export type EndpointRole = "subject"|"object"|"context"|"holder"|"speaker"|"addressee"|"control";
export interface EndpointSupport {role:EndpointRole; ref:RawSubjectRef; anchors:TextAnchor[]}
export interface ClaimSupportAdmission {
  schema:typeof CLAIM_SUPPORT_SCHEMA;
  anchors:TextAnchor[];
  attribution_anchors:TextAnchor[];
  endpoints:EndpointSupport[];
  events:SupportEvent[];
  producer:CanonicalProducer;
  model_ref:string|null;
  authority:AuthorityTier;
  confidence:number;
  sensitivity:Sensitivity;
  at:string;
}
export interface ClaimOccurrence {
  schema:typeof CLAIM_OCCURRENCE_SCHEMA;
  event:SupportEvent;
  start_utf16:number;
  end_utf16:number;
}
const SHA=/^[a-f0-9]{64}$/;
const ROLES=new Set<EndpointRole>(["subject","object","context","holder","speaker","addressee","control"]);
function exact(value:Record<string,unknown>,keys:readonly string[]):boolean {
  return Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
}
function hash(value:unknown):value is string {return typeof value==="string" && SHA.test(value);}
function ref(value:unknown):value is RawSubjectRef {
  return isPlainObject(value) && exact(value,["kind","id"]) && (value.kind==="supplied" || value.kind==="occurrence") &&
    typeof value.id==="string" && isVisibleIdentifier(value.id) && utf8ByteLength(value.id)<=EVENT_LIMITS.subjectIdBytes;
}
function anchor(value:unknown):value is TextAnchor {
  return isPlainObject(value) && exact(value,["event_id","start_utf16","end_utf16"]) && isUlid(value.event_id) &&
    Number.isSafeInteger(value.start_utf16) && Number.isSafeInteger(value.end_utf16) && Number(value.start_utf16)>=0 &&
    Number(value.end_utf16)>Number(value.start_utf16) && Number(value.end_utf16)<=EVENT_LIMITS.textBytes;
}
function sortedUnique<T>(values:readonly T[],key:(v:T)=>string):boolean {
  return values.every((v,i)=>i===0 || key(values[i-1]!)<key(v));
}
export function anchorKey(value:TextAnchor):string {return canonicalJson(value);}
export function endpointKey(value:Pick<EndpointSupport,"role"|"ref">):string {return canonicalJson({role:value.role,ref:value.ref});}
function anchors(value:unknown,min=0):value is TextAnchor[] {
  return Array.isArray(value) && value.length>=min && value.length<=8 && value.every(anchor) && sortedUnique(value,anchorKey);
}
function source(value:unknown):value is SupportSource {
  if(!isPlainObject(value)) return false;
  if(value.kind==="legacy") return exact(value,["kind"]);
  if(value.kind==="native") return exact(value,["kind","request_digest"]) && hash(value.request_digest);
  return value.kind==="enrolled" && exact(value,["kind","source_key","binding_revision","binding_digest","checked_revision","checked_digest"]) &&
    isUlid(value.source_key) && Number.isSafeInteger(value.binding_revision) && Number(value.binding_revision)>0 && hash(value.binding_digest) &&
    Number.isSafeInteger(value.checked_revision) && Number(value.checked_revision)>0 && hash(value.checked_digest);
}
function supportEvent(value:unknown):value is SupportEvent {
  return isPlainObject(value) && exact(value,["event_id","connector_id","source","content_hash_version","content_hash","text_hash","origin_binding"]) &&
    isUlid(value.event_id) && typeof value.connector_id==="string" && isVisibleIdentifier(value.connector_id) && utf8ByteLength(value.connector_id)<=EVENT_LIMITS.identifierBytes &&
    source(value.source) && (value.content_hash_version===1 || value.content_hash_version===2) && hash(value.content_hash) && hash(value.text_hash) && hash(value.origin_binding);
}
function snapshot(raw:string,maxBytes:number):unknown {
  if(utf8ByteLength(raw)>maxBytes) return invalidStoredClaim();
  let value:unknown;
  try { value=JSON.parse(raw); } catch { return invalidStoredClaim(); }
  const result=cloneExactJson(value,"claim_support",{maxDepth:10,maxArrayLength:256,maxKeysPerObject:16,maxStringBytes:4096,maxKeyBytes:64,maxTotalBytes:maxBytes},[]);
  return result===undefined?invalidStoredClaim():result;
}
export function decodeSupport(raw:string):ClaimSupportAdmission {
  const v=snapshot(raw,262144);
  if(!isPlainObject(v) || !exact(v,["schema","anchors","attribution_anchors","endpoints","events","producer","model_ref","authority","confidence","sensitivity","at"]) ||
    v.schema!==CLAIM_SUPPORT_SCHEMA || !anchors(v.anchors,1) || !anchors(v.attribution_anchors) ||
    !Array.isArray(v.endpoints) || v.endpoints.length>256 || !v.endpoints.every(e=>isPlainObject(e) && exact(e,["role","ref","anchors"]) && ROLES.has(e.role as EndpointRole) && ref(e.ref) && anchors(e.anchors,1)) ||
    !Array.isArray(v.events) || v.events.length===0 || v.events.length>8 || !v.events.every(supportEvent) ||
    !isProducer(v.producer) || v.producer==="llm" || !isAuthorityTier(v.authority) || !Number.isFinite(v.confidence) || Number(v.confidence)<0 || Number(v.confidence)>1 ||
    (v.model_ref!==null && (typeof v.model_ref!=="string" || utf8ByteLength(v.model_ref)>4096)) ||
    !["public","personal","private"].includes(String(v.sensitivity)) || !isRfc3339(v.at)) return invalidStoredClaim();
  const admission=v as unknown as ClaimSupportAdmission;
  const all=[...admission.anchors,...admission.attribution_anchors,...admission.endpoints.flatMap(e=>e.anchors)];
  if(all.length>256 || !sortedUnique(admission.events,event=>event.event_id) || !sortedUnique(admission.endpoints,endpointKey) ||
    canonicalJson([...new Set(all.map(a=>a.event_id))].sort())!==canonicalJson(admission.events.map(e=>e.event_id))) return invalidStoredClaim();
  return admission;
}
export function decodeOccurrence(raw:string):ClaimOccurrence {
  const value=snapshot(raw,16384);
  if(!isPlainObject(value) || !exact(value,["schema","event","start_utf16","end_utf16"]) || value.schema!==CLAIM_OCCURRENCE_SCHEMA ||
    !supportEvent(value.event) || !anchor({event_id:value.event.event_id,start_utf16:value.start_utf16,end_utf16:value.end_utf16})) return invalidStoredClaim();
  return value as unknown as ClaimOccurrence;
}
export function semanticKey(meaning:ClaimMeaning):string {
  return sha256Hex(`kizuki.claim-semantic-key/v1\0${canonicalJson(meaning)}`);
}
export function supportKey(meaningKey:string,admission:ClaimSupportAdmission):string {
  // Producer identity and confidence describe admission, never another piece of
  // evidence. Replaying an identical anchor/root set must return its first result.
  return sha256Hex(`kizuki.claim-support-key/v1\0${canonicalJson({semantic_key:meaningKey,
    anchors:admission.anchors,attribution_anchors:admission.attribution_anchors,endpoints:admission.endpoints,
    events:admission.events.map(({source,...event})=>({...event,source:source.kind==="enrolled"?
      {kind:source.kind,source_key:source.source_key,binding_revision:source.binding_revision,binding_digest:source.binding_digest}:source}))})}`);
}
export function meaningEndpoints(meaning:ClaimMeaning):Pick<EndpointSupport,"role"|"ref">[] {
  const refs:Pick<EndpointSupport,"role"|"ref">[]=[];
  if(meaning.discriminator==="assertion") {
    refs.push({role:"subject",ref:meaning.subject});
    if(meaning.object.kind==="subject") refs.push({role:"object",ref:meaning.object.ref});
    for(const role of ["holder","speaker","addressee"] as const) if(meaning.perspective[role]!==null) refs.push({role,ref:meaning.perspective[role]!});
    for(const ref of meaning.context) refs.push({role:"context",ref});
  } else if(meaning.change.action==="merge") refs.push({role:"control",ref:meaning.change.left},{role:"control",ref:meaning.change.right});
  else if(meaning.change.action==="separate") for(const ref of meaning.change.partitions.flat()) refs.push({role:"control",ref});
  return refs.sort((a,b)=>endpointKey(a)<endpointKey(b)?-1:1);
}
/** Bounded current evidence reload. Never infer origin from later machine bytes. */
export function readSupportEvent(db:Database,id:string):CaptureEvent|null {
  using metadata=db.prepare<{valid:number},[string]>(`SELECT (octet_length(text)<=${EVENT_LIMITS.textBytes} AND
    octet_length(subjects)<=${EVENT_LIMITS.eventBytes} AND octet_length(metadata)<=${EVENT_LIMITS.eventBytes} AND
    octet_length(attachments)<=${EVENT_LIMITS.eventBytes} AND octet_length(source_record_id)<=${EVENT_LIMITS.sourceRecordIdBytes}) AS valid
    FROM events WHERE event_id=?`);
  const size=metadata.get(id);
  if(size===null) return null;
  if(size.valid!==1) return invalidStoredClaim();
  using query=db.prepare<EventRow,[string]>("SELECT * FROM events WHERE event_id=?");
  const row=query.get(id);
  if(row===null) return null;
  return validateEventOrigin(db,eventFromRow(row,db));
}
export function currentSupportSource(db:Database,event:CaptureEvent):SupportSource {
  using binding=db.prepare<{source_key:string;grant_revision:number;policy_digest:string;revision:number;checked_digest:string},[string]>(`SELECT b.source_key,b.grant_revision,b.policy_digest,g.revision,g.policy_digest AS checked_digest
    FROM source_event_bindings b JOIN source_grants g ON g.source_key=b.source_key WHERE b.event_id=?`);
  const row=binding.get(event.event_id);
  if(row!==null) return {kind:"enrolled",source_key:row.source_key,binding_revision:row.grant_revision,binding_digest:row.policy_digest,checked_revision:row.revision,checked_digest:row.checked_digest};
  using native=db.prepare<{request_digest:string},[string]>("SELECT request_digest FROM native_owner_evidence WHERE event_id=?");
  const proof=native.get(event.event_id);
  return proof===null?{kind:"legacy"}:{kind:"native",request_digest:proof.request_digest};
}
export function supportEventIdentity(db:Database,event:CaptureEvent):SupportEvent {
  return {event_id:event.event_id,connector_id:event.connector_id,source:currentSupportSource(db,event),
    content_hash_version:event.content_hash_version,content_hash:event.content_hash,text_hash:event.text_hash,origin_binding:event.origin_binding};
}
export function occurrenceId(occurrence:ClaimOccurrence,event:CaptureEvent):string {
  const {source,...identity}=occurrence.event;
  const sourceIdentity=source.kind==="enrolled"?{kind:source.kind,source_key:source.source_key}:source;
  return `occurrence:${sha256Hex(`kizuki.claim-occurrence-id/v1\0${canonicalJson({
    ...identity,source:sourceIdentity,source_record_id:event.source_record_id,
    start_utf16:occurrence.start_utf16,end_utf16:occurrence.end_utf16})}`)}`;
}
export function anchorFits(event:CaptureEvent,span:TextAnchor):boolean {
  const split=(offset:number)=>offset>0 && offset<event.text.length &&
    event.text.charCodeAt(offset-1)>=0xD800 && event.text.charCodeAt(offset-1)<=0xDBFF &&
    event.text.charCodeAt(offset)>=0xDC00 && event.text.charCodeAt(offset)<=0xDFFF;
  return span.event_id===event.event_id && span.start_utf16>=0 && span.end_utf16<=event.text.length && span.end_utf16>span.start_utf16 && !split(span.start_utf16) && !split(span.end_utf16);
}
export function supportEligible(db:Database,admission:ClaimSupportAdmission,scope:SourceReadScope):boolean {
  for(const identity of admission.events) {
    const event=readSupportEvent(db,identity.event_id);
    if(event===null || event.origin!=="external") return false;
    const current=supportEventIdentity(db,event);
    const source=identity.source;
    if(source.kind==="enrolled" && current.source.kind==="enrolled") {
      current.source.checked_revision=source.checked_revision;
      current.source.checked_digest=source.checked_digest;
    }
    if(canonicalJson(current)!==canonicalJson(identity)) return false;
  }
  return sourceEventsAllowed(db,admission.events.map(e=>e.event_id),scope);
}
