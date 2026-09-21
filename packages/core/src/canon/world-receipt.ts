import type { CanonReceipt } from "./receipts";
import { validateRetainedReceipt } from "./receipt-validation";
import { canonicalJson,sha256Hex } from "../util/hash";
import { isPlainObject,cloneExactJson } from "../util/validate";
import { isUlid } from "../util/ulid";
import { isRfc3339 } from "../util/time";

export const WORLD_CANON_RECEIPT_SCHEMA="kizuki.canon-receipt/v2" as const;
export interface WorldClaimBasis {
 readonly claim_id:string;readonly semantic_key:string;readonly supports:readonly {readonly support_key:string;readonly admission_hash:string}[];
}
export interface WorldCanonBasis {
 readonly schema:"kizuki.world-canon-basis/v1";
 readonly before:readonly WorldClaimBasis[]|null;
 readonly after:readonly WorldClaimBasis[]|null;
}
export type RetainedWorldCanonReceipt=CanonReceipt & {
 readonly schema:typeof WORLD_CANON_RECEIPT_SCHEMA;readonly state:"retained";readonly own_id_origin:"core";readonly basis:WorldCanonBasis;
};
export interface ErasedWorldCanonReceipt {
 readonly schema:typeof WORLD_CANON_RECEIPT_SCHEMA;readonly state:"erased";readonly receipt_id:string;
 readonly purge_receipt_id:string;readonly own_id_origin:"core";readonly erased_at:string;readonly sensitivity:"private";readonly integrity:string;
}
export type WorldCanonReceiptRecord=RetainedWorldCanonReceipt|ErasedWorldCanonReceipt;
const HASH=/^[a-f0-9]{64}$/;
export const CANON_RECEIPT_V1_KEYS=["receipt_id","kind","claim_ids","page_path","page_action","before_hash","after_hash","archive_path","writer","producer","model_ref","authority","confidence","sensitivity","taint","provenance","superseded","candidates","retrieval_ops","reverts","reverted_by","at"] as const;
const exact=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

function validClaims(input:unknown):input is WorldClaimBasis[]|null {
 if(input===null)return true;
 if(!Array.isArray(input)||input.length===0||input.length>256)return false;
 let last="";
 for(const claim of input) {
  if(!isPlainObject(claim)||!exact(claim,["claim_id","semantic_key","supports"])||!isUlid(claim.claim_id)||typeof claim.semantic_key!=="string"||!HASH.test(claim.semantic_key)||!Array.isArray(claim.supports)||claim.supports.length===0||claim.supports.length>32||claim.claim_id<=last)return false;
  let prior="";for(const support of claim.supports){if(!isPlainObject(support)||!exact(support,["support_key","admission_hash"])||typeof support.support_key!=="string"||!HASH.test(support.support_key)||support.support_key<=prior||typeof support.admission_hash!=="string"||!HASH.test(support.admission_hash))return false;prior=support.support_key;}last=claim.claim_id;
 }
 return true;
}
export function parseWorldCanonBasis(input:unknown):WorldCanonBasis|null {
 if(!isPlainObject(input)||!exact(input,["schema","before","after"])||input.schema!=="kizuki.world-canon-basis/v1"||!validClaims(input.before)||!validClaims(input.after)||(input.before===null&&input.after===null))return null;
 return structuredClone(input) as unknown as WorldCanonBasis;
}
export function isWorldCanonReceipt(receipt:CanonReceipt):receipt is RetainedWorldCanonReceipt {
 return "schema" in receipt && receipt.schema===WORLD_CANON_RECEIPT_SCHEMA && "state" in receipt && receipt.state==="retained";
}
export function erasedWorldReceiptIntegrity(receipt:Omit<ErasedWorldCanonReceipt,"integrity">):string {
 return sha256Hex(`${WORLD_CANON_RECEIPT_SCHEMA}#erased\0${canonicalJson(receipt)}`);
}
export function eraseWorldReceipt(receiptId:string,purgeReceiptId:string,at:string):ErasedWorldCanonReceipt {
 const core={schema:WORLD_CANON_RECEIPT_SCHEMA,state:"erased" as const,receipt_id:receiptId,purge_receipt_id:purgeReceiptId,own_id_origin:"core" as const,erased_at:at,sensitivity:"private" as const};
 return {...core,integrity:erasedWorldReceiptIntegrity(core)};
}

/** Retained common fields are validated by the existing receipt codec supplied by its owner. */
export function parseWorldCanonReceipt(input:unknown,validateRetained:(value:unknown)=>void = value => validateRetainedReceipt(value, true)):WorldCanonReceiptRecord|null {
 let value:unknown;const errors:string[]=[];
 try{value=cloneExactJson(input,"world_canon_receipt",{maxDepth:12,maxKeysPerObject:32,maxArrayLength:32768,maxStringBytes:4096,maxKeyBytes:128,maxTotalBytes:4*1024*1024},errors);}catch{return null;}
 if(errors.length||!isPlainObject(value)||value.schema!==WORLD_CANON_RECEIPT_SCHEMA||value.own_id_origin!=="core")return null;
 if(value.state==="erased") {
  if(!exact(value,["schema","state","receipt_id","purge_receipt_id","own_id_origin","erased_at","sensitivity","integrity"])||!isUlid(value.receipt_id)||!isUlid(value.purge_receipt_id)||!isRfc3339(value.erased_at)||value.sensitivity!=="private"||typeof value.integrity!=="string")return null;
  const {integrity,...fields}=value;
  if(erasedWorldReceiptIntegrity(fields as unknown as Omit<ErasedWorldCanonReceipt,"integrity">)!==integrity)return null;
  return value as unknown as ErasedWorldCanonReceipt;
 }
 if(value.state!=="retained"||!exact(value,[...CANON_RECEIPT_V1_KEYS,"schema","state","own_id_origin","basis"]))return null;
 const basis=parseWorldCanonBasis(value.basis);if(basis===null)return null;
 const legacy=Object.fromEntries(CANON_RECEIPT_V1_KEYS.map(key=>[key,value[key]]));
 try{validateRetained(legacy);}catch{return null;}
 if(!Array.isArray(value.claim_ids)||value.claim_ids.some(id=>![...(basis.before??[]),...(basis.after??[])].some(claim=>claim.claim_id===id)))return null;
 return {...value,basis} as unknown as RetainedWorldCanonReceipt;
}
