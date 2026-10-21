import type { Database } from "bun:sqlite";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { insertClaim } from "../../src/claims/store";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldCanonPath, worldClaimHandle } from "../../src/canon/world-materialization";
import { getClaim } from "../../src/claims/store";
import { correct } from "../../src/correction/correct";
import { undoReceipt } from "../../src/canon/undo";
import { budget } from "../canon/helpers";
import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { canonFixture } from "../canon/helpers";
import { worldFixture } from "./world-fixture";
import { readWorldView, serveWorldView, type WorldReadResult } from "../../src/serving/world-view";
import { markClaimReverted, reinstateClaim } from "../../src/claims/store";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { purgeEvents } from "../../src/ledger/purge";
import { applyClaimHistorySchema, beginClaimHistoryRestore } from "../../src/world/tables/known";
import { validateHistoryPage } from "../../src/contracts/world-history";
import { WORLD_VIEW_TABLE_SPECS } from "../../src/world/tables/views";
import { worldDependenciesCurrent, worldDependencies } from "../../src/world/dependencies";
import { resolveKnownTime } from "../../src/world/known/cutoff";
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";

setDefaultTimeout(120000);
const MONDAY="2030-01-07T00:00:00.000Z", TUESDAY="2030-01-08T00:00:00.000Z", WEDNESDAY="2030-01-09T00:00:00.000Z", THURSDAY="2030-01-10T00:00:00.000Z";
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const run of cleanup.splice(0).reverse())run();});
async function fixture(validFrom=MONDAY){const f=canonFixture();cleanup.push(f.dispose);f.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(WEDNESDAY);const world=await worldFixture(f.db,{validFrom});return {...f,...world,ctx:{...world.ctx,vaultPath:f.vault}};}
function data(result:WorldReadResult){if(!("result" in result)||!("data" in result.result))throw new Error(JSON.stringify(result));return result.result.data;}
function card(result:WorldReadResult){const body=data(result);if(body.schema!=="kizuki.concept-card/v1")throw new Error("no card");return body;}
function at(f:Awaited<ReturnType<typeof fixture>>,knownAt:unknown={kind:"time",at:WEDNESDAY},extra:Record<string,unknown>={}){return {operation:"concept",concept:f.ref,valid:{kind:"at",at:MONDAY},knownAt,...extra};}
function snap(f:Awaited<ReturnType<typeof fixture>>){const body=card(serveWorldView(f.ctx,at(f)).data);if(body.knownAt.kind!=="snapshot")throw new Error("no snapshot");return body.knownAt;}

test("a Monday-valid fact first learned Wednesday is absent on Tuesday, and the actual public gate serves Wednesday with an opaque snapshot",async()=>{
 const f=await fixture();expect(serveWorldView(f.ctx,at(f,{kind:"time",at:TUESDAY})).data).toEqual({status:"not_found"});
 const served=serveWorldView(f.ctx,at(f)),body=card(served.data);expect(body.definitions).toHaveLength(1);expect(body.definitions[0]!.valid).toEqual({kind:"known",from:MONDAY,until:null});
 expect(body.knownAt.kind).toBe("snapshot");expect(body.coverage.history).toBe("retained_for_query");expect(JSON.stringify(served)).not.toContain("sequence");expect(JSON.stringify(served)).not.toContain(f.claims[0]!);
 expect(serveWorldView(f.ctx,at(f,{kind:"time",at:WEDNESDAY},{valid:{kind:"at",at:"2030-01-06T00:00:00.000Z"}})).data).toEqual({status:"not_found"});
});

test("a saved exact cutoff survives same-clock later retraction, while a fresh timestamp resolves the newer state",async()=>{
 const f=await fixture(),saved=snap(f);markClaimReverted(f.db,f.claims[2]!,MONDAY);
 expect(card(serveWorldView(f.ctx,at(f,saved)).data).definitions).toHaveLength(1);
 expect(card(serveWorldView(f.ctx,at(f)).data).definitions).toHaveLength(0);
 const history=data(serveWorldView(f.ctx,at(f,{kind:"current"},{operation:"history"})).data);
 expect(history.schema).toBe("kizuki.world-history/v1");if(history.schema!=="kizuki.world-history/v1")throw new Error("history missing");
 expect(validateHistoryPage(history).ok).toBe(true);expect(history.transitions.some(row=>row.before==="active"&&row.after==="retracted")).toBe(true);
 const old=data(serveWorldView(f.ctx,at(f,saved,{operation:"history"})).data);if(old.schema!=="kizuki.world-history/v1")throw new Error("history missing");expect(old.transitions.every(row=>row.after!=="retracted")).toBe(true);
 reinstateClaim(f.db,f.claims[2]!,null);expect(card(serveWorldView(f.ctx,at(f)).data).definitions).toHaveLength(1);
});

test("later support admissions do not strengthen a saved interpretation",async()=>{
 const f=await fixture(),saved=snap(f);const original=card(serveWorldView(f.ctx,at(f,saved)).data);expect(original.definitions[0]!.assessments).toHaveLength(1);
 await worldFixture(f.db,{sourceKey:f.sourceKey,validFrom:MONDAY});
 expect(card(serveWorldView(f.ctx,at(f,saved)).data).definitions[0]!.assessments).toHaveLength(1);
 expect(card(serveWorldView(f.ctx,at(f)).data).definitions[0]!.assessments).toHaveLength(2);
});

test("upgrade baselines refuse the earlier past and explicitly identify the retained baseline",async()=>{
 const f=await fixture();f.db.transaction(()=>{beginClaimHistoryRestore(f.db);f.db.exec("DELETE FROM claim_lifecycle_history; DELETE FROM claim_history_coverage");f.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(THURSDAY);applyClaimHistorySchema(f.db);}).immediate();
 expect(serveWorldView(f.ctx,at(f)).data).toMatchObject({result:{status:"unavailable",reason:"history"}});
 const body=card(serveWorldView(f.ctx,at(f,{kind:"time",at:THURSDAY})).data);expect(body.definitions).toHaveLength(1);expect(body.coverage.history).toBe("baseline_only");
});

test("current consent revocation invalidates snapshot uniformly and history cannot resurrect it",async()=>{
 const f=await fixture(),saved=snap(f);revokeSourceGrant(f.db,{source_key:f.sourceKey,expected_revision:1,operation_id:"known-revoke"});
 const lost=serveWorldView(f.ctx,at(f,saved)).data,unknown=serveWorldView(f.ctx,at(f,{kind:"snapshot",ref:{kind:"snapshot",token:"A".repeat(43)}})).data;
 expect(lost).toEqual(unknown);expect(lost).toMatchObject({result:{status:"new_view_required"}});
 expect(serveWorldView(f.ctx,at(f,{kind:"time",at:WEDNESDAY},{operation:"history"})).data).toEqual({status:"not_found"});
});

test("physical purge erases token dependencies and old-time history never returns erased text",async()=>{
 const f=await fixture(),saved=snap(f);purgeEvents(f.db,f.vault,{event_id:f.eventId},"known-purge");
 expect(serveWorldView(f.ctx,at(f,saved)).data).toMatchObject({result:{status:"new_view_required"}});
 expect(serveWorldView(f.ctx,at(f,{kind:"time",at:WEDNESDAY},{operation:"history"})).data).toEqual({status:"not_found"});
 expect(f.db.query("SELECT * FROM claim_lifecycle_history").all()).toEqual([]);
});

test("snapshot subject and principal scopes cannot be switched and cache reset requires a new view",async()=>{
 const f=await fixture(),saved=snap(f);const other=await worldFixture(f.db,{subject:"other",label:"Other"});
 expect(readWorldView(f.ctx,at(f,saved,{concept:other.ref}))).toMatchObject({result:{status:"new_view_required"}});
 const agent=addAgent(f.db,"known-reader",OWNER_AGENT_GRANT),principal=authenticate(f.db,agent.token)!;
 expect(readWorldView({...f.ctx,principal},at(f,saved))).toMatchObject({result:{status:"new_view_required"}});
 for(const spec of [...WORLD_VIEW_TABLE_SPECS].reverse())if(spec.name==="world_view_tokens")f.db.exec("DELETE FROM world_view_tokens");
 expect(readWorldView(f.ctx,at(f,saved))).toMatchObject({result:{status:"new_view_required"}});
});

test("a temporal dependency accepts retained superseded state but still requires current authorized support",async()=>{
 const f=await fixture();const deps=worldDependencies();deps.cutoff=resolveKnownTime(f.db,WEDNESDAY);deps.claims.add(f.claims[2]!);
 const key=f.db.query<{support_key:string},[string]>("SELECT support_key FROM claim_v2_support WHERE claim_id=?").get(f.claims[2]!)!.support_key;deps.supports.add(key);
 markClaimReverted(f.db,f.claims[2]!,MONDAY);expect(worldDependenciesCurrent(f.ctx,deps)).toBe(true);
 revokeSourceGrant(f.db,{source_key:f.sourceKey,expected_revision:1,operation_id:"deps-revoke"});expect(worldDependenciesCurrent(f.ctx,deps)).toBe(false);
});


test("real correction and undo expose opaque causing receipts, while a saved prior cutoff keeps the prior definition",async()=>{
 const f=await fixture("2026-01-01T00:00:00.000Z"),saved=snap(f);
 const claims=f.claims.map(id=>getClaim(f.db,id)!);
 applyCanonWrite(f.io,claims,{action:"create",rel_path:worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!)},{writer:"loop",budget:budget()});
 const changed=await correct(f.io,{statement:"Use prior odds and the likelihood ratio.",target:{claim_id:f.claims[2]!}});expect(changed.receipt_id).not.toBeNull();
 const old=card(serveWorldView(f.ctx,at(f,saved)).data);expect(old.definitions[0]!.object).toEqual({kind:"literal",value:"Revise beliefs using evidence"});
 const history=data(serveWorldView(f.ctx,at(f,{kind:"current"},{operation:"history",valid:{kind:"all"}})).data);if(history.schema!=="kizuki.world-history/v1")throw new Error("history missing");
 const token=f.db.query<{wire_ref:string},[string]>("SELECT wire_ref FROM world_known_receipt_refs WHERE receipt_id=?").get(changed.receipt_id!)!.wire_ref;
 expect(history.transitions.some(row=>row.after==="superseded"&&row.causeReceipt?.token===token)).toBe(true);
 expect(JSON.stringify(history)).not.toContain(changed.receipt_id!);
 const undo=await undoReceipt(f.io,changed.receipt_id!);const after=data(serveWorldView(f.ctx,at(f,{kind:"current"},{operation:"history",valid:{kind:"all"}})).data);if(after.schema!=="kizuki.world-history/v1")throw new Error("history missing");
 const undoToken=f.db.query<{wire_ref:string},[string]>("SELECT wire_ref FROM world_known_receipt_refs WHERE receipt_id=?").get(undo.receipt_id)!.wire_ref;
 expect(after.transitions.some(row=>row.after==="active"&&row.causeReceipt?.token===undoToken)).toBe(true);
 purgeEvents(f.db,f.vault,{event_id:f.eventId},"receipt-erasure");
 expect(f.db.query("SELECT 1 FROM world_known_receipt_refs WHERE claim_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(f.claims))).toEqual([]);
});

test("valid-time-ineligible transitions cannot exhaust the history window",async()=>{
 const f=await fixture("2026-01-01T00:00:00.000Z");
 f.db.query("UPDATE claims SET valid_to=? WHERE claim_id=?").run("2027-01-01T00:00:00.000Z",f.claims[2]!);
 for(let i=0;i<150;i++)f.db.query("UPDATE claims SET status=? WHERE claim_id=?").run(i%2===0?"reverted":"live",f.claims[2]!);
 f.db.query("UPDATE claims SET status='live',valid_to=NULL WHERE claim_id=?").run(f.claims[2]!);
 const body=data(serveWorldView(f.ctx,at(f,{kind:"current"},{operation:"history"})).data);if(body.schema!=="kizuki.world-history/v1")throw new Error("history missing");
 expect(body.transitions).toHaveLength(4);expect(body.coverage.gaps).not.toContain("traversal_limit");
 const all=data(serveWorldView(f.ctx,at(f,{kind:"current"},{operation:"history",valid:{kind:"all"}})).data);if(all.schema!=="kizuki.world-history/v1")throw new Error("history missing");
 expect(all.transitions).toHaveLength(128);expect(all.coverage.gaps).toContain("traversal_limit");
});


function afterSnapshot(db: Database, mutate:()=>void):Database {
 let fired=false;
 return new Proxy(db,{get(target,key){const value=Reflect.get(target,key,target);if(key==="transaction")return(run:()=>unknown)=>{
  const tx=target.transaction(run),finish=(result:unknown)=>{if(!fired&&!target.inTransaction&&result!==null&&typeof result==="object"&&"withheld" in result){fired=true;mutate();}return result;};
  return Object.assign(()=>finish(tx()),{immediate:()=>finish(tx.immediate())});
 };return typeof value==="function"?value.bind(target):value;}});
}
test("final authority recheck keeps the first cutoff and cannot admit a later same-clock claim",async()=>{
 const f=await fixture();const original=JSON.parse(f.db.query<{admission:string},[string]>("SELECT admission FROM claim_v2_support WHERE claim_id=? LIMIT 1").get(f.claims[2]!)!.admission).semantic as ClaimV2Assertion;
 const semantic={...original,object:{kind:"literal" as const,value:"Late replacement"}};
 const stored=await insertClaim({db:f.db},{kind:"claim",body:"Late replacement",provenance:[f.eventId],producer:"deterministic",confidence:0.8,sensitivity:"public",subjects:[semantic.subject.id],semantic,
  world_admission:{schema:"kizuki.world-admission/v1",semantic,rendering:{body:"Late replacement",frontmatter:{}},authority:"model_inference",confidence:0.5,epistemicKind:"model_inference"}});
 if(stored.outcome!=="stored")throw new Error(`unexpected ${stored.outcome}`);const later=stored.claim.claim_id;markClaimReverted(f.db,later,MONDAY);
 const raced={...f.ctx,db:afterSnapshot(f.db,()=>{
  f.db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.rendering.body','owner access') WHERE claim_id=?").run(f.claims[2]!);
  reinstateClaim(f.db,later,null);
 })};
 const response=card(serveWorldView(raced,at(f)).data);expect(response.definitions).toHaveLength(0);
 const next=card(serveWorldView(f.ctx,at(f)).data);expect(next.definitions).toHaveLength(1);expect(next.definitions[0]!.object).toEqual({kind:"literal",value:"Late replacement"});
});


test("purging a later unselected support invalidates old snapshots and exposes only the new retained baseline",async()=>{
 const f=await fixture(),saved=snap(f);const extra=await worldFixture(f.db,{sourceKey:f.sourceKey,validFrom:MONDAY});
 f.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(THURSDAY);
 purgeEvents(f.db,f.vault,{event_id:extra.eventId},"partial-history-purge");
 expect(serveWorldView(f.ctx,at(f,saved)).data).toMatchObject({result:{status:"new_view_required"}});
 expect(serveWorldView(f.ctx,at(f)).data).toMatchObject({result:{status:"unavailable",reason:"history"}});
 const retained=card(serveWorldView(f.ctx,at(f,{kind:"time",at:THURSDAY})).data);
 expect(retained.definitions).toHaveLength(1);expect(retained.coverage.history).toBe("baseline_only");
});


test("history's Concept selector does not reinterpret a Situation token",async()=>{
 const f=await fixture();const situation=await worldFixture(f.db,{kind:"situation",subject:"project:release",label:"Release"});
 expect(serveWorldView(f.ctx,at(f,{kind:"current"},{operation:"history",concept:situation.ref})).data).toEqual({status:"not_found"});
});


test("a new current authority hold also suppresses an older otherwise eligible snapshot",async()=>{
 const f=await fixture(),saved=snap(f);const extra=await worldFixture(f.db,{sourceKey:f.sourceKey,validFrom:MONDAY});
 f.db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.rendering.body','owner access') WHERE claim_id=? AND support_key IN (SELECT support_key FROM claim_v2_support_events WHERE event_id=?)").run(f.claims[2]!,extra.eventId);
 expect(card(serveWorldView(f.ctx,at(f,saved)).data).definitions).toHaveLength(0);
 expect(card(serveWorldView(f.ctx,at(f,{kind:"current"})).data).definitions).toHaveLength(0);
});
