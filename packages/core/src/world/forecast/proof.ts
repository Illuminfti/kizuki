import type { ServeContext } from "../../serving/types";
import { getClaim } from "../../claims/store";
import { claimReadSql } from "../../claims/read-scope";
import { semanticKey } from "../../claims/claim-v2-keys";
import { claimReader, claimPublicationFingerprint } from "../../serving/claims";
import { canonicalJson, sha256Hex } from "../../util/hash";
import { isPlainObject } from "../../util/validate";
import { eligibleWorldClaim, type Eligible } from "../pipeline/eligible";
import type { ReadFrame } from "../pipeline/frame";
import { recordWorldDependencies } from "../dependencies";
import { authorizedClaimSql, authorizedSupportSql } from "../policy-sql";
import { knownHeldSql } from "../known/cutoff";
import { identityReceiptCurrent } from "../identity-receipt";

export interface ForecastProof {
  readonly kind: "typed" | "legacy";
  readonly claim: string;
  readonly fingerprint: string;
  readonly witnesses: readonly string[];
  readonly supports: readonly string[];
  readonly events: readonly string[];
  readonly sources: readonly string[];
  readonly receipt: string | null;
}
const strings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(s => typeof s === "string" && s.length > 0 && s.length <= 256) && new Set(v).size === v.length;
export function parseForecastProof(value: unknown): ForecastProof | null {
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== ["kind","claim","fingerprint","witnesses","supports","events","sources","receipt"].sort().join() ||
      !["typed","legacy"].includes(String(value.kind)) || typeof value.claim !== "string" || value.claim.length === 0 || value.claim.length > 128 ||
      typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !strings(value.witnesses,32) || !strings(value.supports,96) || !strings(value.events,256) || !strings(value.sources,96) ||
      !(value.receipt === null || typeof value.receipt === "string" && value.receipt.length <= 128)) return null;
  if (value.events.length === 0 || (value.kind === "typed" ? value.witnesses.length === 0 || !value.witnesses.every(s => (value.supports as string[]).includes(s)) : value.supports.length > 0 || value.witnesses.length > 0)) return null;
  return value as unknown as ForecastProof;
}
function sorted(values: Iterable<string>): string[] { return [...new Set(values)].sort(); }
export function typedProof(frame: ReadFrame, item: Eligible): ForecastProof {
  const supports = sorted(item.supports.flatMap(s => [s.row.support_key, ...(s.admission.schema === "kizuki.world-admission/v2" ? s.admission.grounding.flatMap(g => [g.classification.support_key,g.label.support_key]) : [])]));
  const pins = supports.map(key => {
    const row = frame.ctx.db.query<{ source_key: string; admission: string },[string]>("SELECT source_key,admission FROM claim_v2_support WHERE support_key=?").get(key);
    if (row === null) throw new Error("forecast support disappeared");
    const events = frame.ctx.db.query<{event_id:string;event_content_hash:string},[string]>("SELECT event_id,event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id").all(key);
    return {key,source:row.source_key,admission:sha256Hex(row.admission),events};
  });
  const receipt = item.supports.some(s => s.row.support_origin === "native_owner")
    ? frame.ctx.db.query<{receipt_id:string|null},[string]>("SELECT receipt_id FROM claims WHERE claim_id=?").get(item.claimId)?.receipt_id ?? null : null;
  return {kind:"typed",claim:item.claimId,fingerprint:sha256Hex(canonicalJson([semanticKey(item.semantic),pins,receipt])),witnesses:sorted(item.supports.map(s=>s.row.support_key)),supports,
    events:sorted(pins.flatMap(p=>p.events.map(e=>e.event_id))),sources:sorted(pins.map(p=>p.source).filter(s=>s!=="native-owner")),receipt};
}
export function legacyProof(frame: ReadFrame, id: string): ForecastProof | null {
  const claim=getClaim(frame.ctx.db,id), reader=claimReader(frame.ctx.db,frame.ctx.principal.grant,{owner:frame.ctx.principal.kind==="owner",purpose:frame.ctx.sourcePurpose??"recall"});
  if(frame.ctx.db.query("SELECT 1 FROM world_forecast_outcome_admissions WHERE claim_id=?").get(id)===null||claim===null||claim.status!=="live"||!reader.canRead(claim)||frame.ctx.db.query("SELECT 1 FROM claims WHERE claim_id=? AND is_world_typed=0 AND predicate IN ('outcome.self_report','outcome.provider_ack','outcome.observation','outcome.review')").get(id)===null)return null;
  const sources=frame.ctx.db.query<{source_key:string},[string]>("SELECT DISTINCT source_key FROM source_event_bindings WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY source_key").all(JSON.stringify(claim.provenance)).map(r=>r.source_key);
  return {kind:"legacy",claim:id,fingerprint:claimPublicationFingerprint(claim),witnesses:[],supports:[],events:sorted(claim.provenance),sources,receipt:null};
}
/** No substitution by later supports, labels or roots. Every frozen dependency remains authorized. */
export function forecastProofCurrent(frame: ReadFrame, proof: ForecastProof): boolean {
  if(proof.kind==="legacy"){
    const current=legacyProof(frame,proof.claim);
    if(current===null||canonicalJson(current)!==canonicalJson(proof))return false;
    frame.dependencies?.legacyClaims.set(proof.claim,proof.fingerprint);
    for(const id of proof.events)frame.dependencies?.events.add(id);
    return true;
  }
  const item=eligibleWorldClaim(frame.ctx,proof.claim,{kind:"all"},frame.budget,{supportKeys:proof.witnesses});
  if(item===null||item.overflow||canonicalJson(typedProof(frame,item))!==canonicalJson(proof))return false;
  if(proof.receipt!==null&&!identityReceiptCurrent(frame.ctx.db,proof.claim,proof.receipt))return false;
  if(frame.dependencies){recordWorldDependencies(frame.dependencies,item);if(proof.receipt!==null)frame.dependencies.identityReceipts.set(proof.claim,proof.receipt);}
  return true;
}
/** Current authority for a private proof row named pin, joined to claims as base. */
export function forecastProofScopeSql(ctx: ServeContext) {
  const typed=authorizedClaimSql(ctx), support=authorizedSupportSql(ctx), held=knownHeldSql(ctx,"base");
  const legacy=claimReadSql(ctx.db,{grant:ctx.principal.grant,source:{owner:ctx.principal.kind==="owner",purpose:ctx.sourcePurpose??"recall"}},"base");
  const allowed=`base.status='live' AND (
    (json_extract(pin.proof,'$.kind')='typed' AND ${typed.sql} AND NOT ${held.sql}
      AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(pin.proof,'$.supports')) k LEFT JOIN claim_v2_support s ON s.support_key=k.value WHERE s.support_key IS NULL OR COALESCE((${support.sql}),0)=0))
    OR (json_extract(pin.proof,'$.kind')='legacy' AND ${legacy.sql}))`;
  return {sql:allowed,bindings:[...typed.bindings,...held.bindings,...support.bindings,...legacy.bindings]};
}
/** Input authority precedes LIMIT. A hidden later resolution cannot hide a prediction. */
export function forecastScopeSql(ctx:ServeContext){
  const allowed=forecastProofScopeSql(ctx);
  return {sql:`EXISTS(SELECT 1 FROM world_forecast_inputs i WHERE i.forecast_id=f.forecast_id) AND NOT EXISTS(
    SELECT 1 FROM world_forecast_inputs pin LEFT JOIN claims base ON base.claim_id=pin.claim_id
    WHERE pin.forecast_id=f.forecast_id AND (base.claim_id IS NULL OR COALESCE((${allowed.sql}),0)=0))`,bindings:allowed.bindings};
}
