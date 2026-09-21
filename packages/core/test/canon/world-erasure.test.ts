import {expect,test} from "bun:test";
import {existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {canonFixture,budget} from "./helpers";
import {worldFixture} from "../serving/world-fixture";
import {parseFrontmatter,serializePage} from "../../src/vault/frontmatter";
import {hashBytes} from "../../src/vault/write";
import {getClaim} from "../../src/claims/store";
import {applyCanonWrite} from "../../src/canon/apply";
import {worldClaimHandle,worldCanonPath} from "../../src/canon/world-materialization";
import {runPurge} from "../../src/ledger/purge";
import {getCanonReceiptRecord,isErasedReceipt} from "../../src/canon/receipts";
import {undoReceipt} from "../../src/canon/undo";

test("real event purge removes typed prose and replaces its historical receipt with the strict erased arm",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const outcome=await runPurge(f.db,f.vault,{event_id:world.eventId},"erase world fixture");
  expect(outcome.rewritten).toHaveLength(1);
  expect(existsSync(join(f.vault,path))).toBe(false);
  expect(isErasedReceipt(getCanonReceiptRecord(f.db,original.receipt_id)!)).toBe(true);
  const log=readFileSync(join(f.vault,".kizuki/receipts/promotions.jsonl"),"utf8");
  expect(log).not.toContain(original.after_hash);expect(log).not.toContain(path);expect(log).not.toContain(world.eventId);
  expect(f.db.query("SELECT page_path,after_hash,world_basis FROM canon_receipts WHERE receipt_id=?").get(original.receipt_id)).toEqual({page_path:null,after_hash:null,world_basis:null});
  await expect(undoReceipt(f.io,original.receipt_id)).rejects.toMatchObject({code:"erased"});
  expect(f.db.query("SELECT COUNT(*) AS n FROM canon_write_intents").get()).toEqual({n:0});
 }finally{f.dispose();}
});

import {correct} from "../../src/correction/correct";
import {revokeSourceGrant,resumeSourceRevocation} from "../../src/ledger/source-grants";
import {initSearch} from "../../src/search";
import {initGraph} from "../../src/graph";
import {getCanonReceipt,latestReceiptForPage} from "../../src/canon/receipts";
import {isWorldCanonReceipt} from "../../src/canon/world-receipt";
import {assertWorldCanonPage} from "../../src/canon/world-materialization";

test("source revocation erases both historical images while actual native correction renders independently",async()=>{
 const f=canonFixture();try {
  initSearch(f.db);initGraph(f.db);
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const correction=await correct(f.io,{statement:"Use prior odds and the likelihood ratio.",target:{claim_id:world.claims[2]!}});
  const changed=getCanonReceipt(f.db,correction.receipt_id!)!;
  expect(changed.archive_path).not.toBeNull();expect(existsSync(join(f.vault,changed.archive_path!))).toBe(true);
  revokeSourceGrant(f.db,{source_key:world.sourceKey,expected_revision:1,operation_id:"erase-native-canon-source"});
  const outcome=await resumeSourceRevocation(f.db,f.vault,"erase-native-canon-source",{ownedRetrieval:{stores:async()=>({stores:[],absent_store_ids:[]})}});
  expect({status:outcome.status,blockers:outcome.purge_blockers}).toEqual({status:"purged",blockers:[]});
  expect(existsSync(join(f.vault,changed.archive_path!))).toBe(false);
  const bytes=readFileSync(join(f.vault,path));
  expect(bytes.toString("utf8")).toContain("Use prior odds and the likelihood ratio.");
  expect(bytes.toString("utf8")).not.toContain("Bayesian updating");
  expect(bytes.toString("utf8")).not.toContain(world.eventId);
  const current=latestReceiptForPage(f.db,path)!;expect(isWorldCanonReceipt(current)).toBe(true);
  if(!isWorldCanonReceipt(current))throw new Error("typed survivor receipt required");
  expect(current.before_hash).toBeNull();expect(current.basis.before).toBeNull();assertWorldCanonPage(f.db,current,bytes,"after");
  for(const receipt of [original,changed]) {
    expect(isErasedReceipt(getCanonReceiptRecord(f.db,receipt.receipt_id)!)).toBe(true);
    const log=readFileSync(join(f.vault,".kizuki/receipts/promotions.jsonl"),"utf8");
    expect(log).not.toContain(receipt.after_hash);
    await expect(undoReceipt(f.io,receipt.receipt_id)).rejects.toMatchObject({code:"erased"});
  }
 }finally{f.dispose();}
});

import {recoverCanonWrites} from "../../src/canon/recovery";
import {readCanonWriteIntent,assertCanonAdmission,parseCanonWriteIntent} from "../../src/canon/write-intent";
test("typed erasure recovers exact published bytes and redacted log after receipt-row transaction failure",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const originalBytes=readFileSync(join(f.vault,path));
  f.db.exec("CREATE TRIGGER interrupt_world_erasure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt interruption'); END");
  await expect(runPurge(f.db,f.vault,{event_id:world.eventId},"interrupted world erasure")).rejects.toThrow("fixture receipt interruption");
  expect(existsSync(join(f.vault,path))).toBe(false);
  expect(isErasedReceipt(getCanonReceiptRecord(f.db,original.receipt_id)!)).toBe(false);
  const intent=readCanonWriteIntent(f.db)!;expect(intent.version).toBe(3);
  if(intent.version!==3)throw new Error("typed erasure intent required");
  const tampered=structuredClone(intent);tampered.erasure.archives.push({path:"archive/unrelated.md",hash:original.after_hash});
  expect(()=>assertCanonAdmission(f.db,tampered)).toThrow("archive_changed");
  const forged=structuredClone(intent),page=parseFrontmatter(originalBytes.toString("utf8"));
  page.data["sources"]=[];page.body="Unadmitted replacement prose.\n";
  const bytes=Buffer.from(serializePage(page));forged.after_base64=bytes.toString("base64");
  forged.receipt={...forged.receipt,after_hash:hashBytes(bytes)};
  expect(()=>parseCanonWriteIntent(forged)).toThrow("intent_invalid");
  expect(()=>assertCanonAdmission(f.db,forged)).toThrow("intent_invalid");

  f.db.exec("DROP TRIGGER interrupt_world_erasure");
  expect(recoverCanonWrites(f.io).completed).toEqual([intent.receipt.receipt_id]);
  expect(isErasedReceipt(getCanonReceiptRecord(f.db,original.receipt_id)!)).toBe(true);
  expect(existsSync(join(f.vault,path))).toBe(false);
  const lines=readFileSync(join(f.vault,".kizuki/receipts/promotions.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  expect(lines.filter(line=>line.receipt_id===intent.receipt.receipt_id)).toHaveLength(1);
  expect(f.db.query("SELECT COUNT(*) AS n FROM canon_write_intents").get()).toEqual({n:0});
 }finally{f.dispose();}
});

for(const mode of ["source","event"] as const)test(`${mode} purge erases archives and receipts after typed create was undone`,async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const undo=await undoReceipt(f.io,original.receipt_id);
  expect(existsSync(join(f.vault,path))).toBe(false);expect(undo.archive_path).not.toBeNull();
  if(mode==="source") {
    revokeSourceGrant(f.db,{source_key:world.sourceKey,expected_revision:1,operation_id:"erase-undone-source"});
    const result=await resumeSourceRevocation(f.db,f.vault,"erase-undone-source",{ownedRetrieval:{stores:async()=>({stores:[],absent_store_ids:[]})}});
    expect({status:result.status,blockers:result.purge_blockers}).toEqual({status:"purged",blockers:[]});
  }else await runPurge(f.db,f.vault,{event_id:world.eventId},"erase undone event");
  expect(existsSync(join(f.vault,undo.archive_path!))).toBe(false);
  for(const receipt of [original,undo])expect(isErasedReceipt(getCanonReceiptRecord(f.db,receipt.receipt_id)!)).toBe(true);
  expect(readFileSync(join(f.vault,".kizuki/receipts/promotions.jsonl"),"utf8")).not.toContain(world.eventId);
 }finally{f.dispose();}
});

import {insertClaim} from "../../src/claims/store";
import {parseWorldAdmission} from "../../src/contracts/world-admission";
test("event purge finds source history even when the current page has only independent native citations",async()=>{
 const f=canonFixture();try {
  initSearch(f.db);initGraph(f.db);
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const oldAdmission=parseWorldAdmission(JSON.parse(f.db.query<{admission:string},[string]>("SELECT admission FROM claim_v2_support WHERE claim_id=?").get(world.claims[2]!)!.admission))!;
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const removed=await undoReceipt(f.io,original.receipt_id);
  const semantic={...oldAdmission.semantic,object:{kind:"literal" as const,value:"Source-supported second interpretation"}};
  const result=await insertClaim({db:f.db},{kind:"claim",body:"Source-supported second interpretation",provenance:[world.eventId],producer:"deterministic",confidence:0.8,semantic,world_admission:{...oldAdmission,semantic,rendering:{body:"Source-supported second interpretation",frontmatter:{}}}});
  if(result.outcome!=="stored")throw new Error("fresh source assertion required");
  const second=applyCanonWrite(f.io,result.claim,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const correction=await correct(f.io,{statement:"Independent owner interpretation.",target:{claim_id:result.claim.claim_id}});
  const corrected=getCanonReceipt(f.db,correction.receipt_id!)!;
  expect(readFileSync(join(f.vault,path),"utf8")).not.toContain(world.eventId);
  await runPurge(f.db,f.vault,{event_id:world.eventId},"erase historical source only");
  expect(readFileSync(join(f.vault,path),"utf8")).toContain("Independent owner interpretation.");
  for(const receipt of [original,removed,second,corrected]) {
    expect(isErasedReceipt(getCanonReceiptRecord(f.db,receipt.receipt_id)!)).toBe(true);
    if(receipt.archive_path!==null)expect(existsSync(join(f.vault,receipt.archive_path))).toBe(false);
  }
  expect(readFileSync(join(f.vault,".kizuki/receipts/promotions.jsonl"),"utf8")).not.toContain(world.eventId);
 }finally{f.dispose();}
});
