import { expect,test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseFrontmatter,serializePage } from "../../src/vault/frontmatter";
import { join } from "node:path";
import { canonFixture,budget } from "./helpers";
import { worldFixture } from "../serving/world-fixture";
import { getClaim } from "../../src/claims/store";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldClaimHandle,worldCanonPath,assertWorldReceiptBasis,assertWorldCanonPage } from "../../src/canon/world-materialization";
import { isWorldCanonReceipt } from "../../src/canon/world-receipt";
import { readCanonWriteIntent } from "../../src/canon/write-intent";

test("real admitted typed claims render through the same canon writer while their legacy parents stay neutral",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db,{floor:"private"});
  const claim=getClaim(f.db,world.claims[0]!)!,path=worldCanonPath(worldClaimHandle(f.db,claim.claim_id)!);
  expect(claim.body).toBe("");expect(claim.subject).toBeNull();
  const receipt=applyCanonWrite(f.io,claim,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  expect(isWorldCanonReceipt(receipt)).toBe(true);
  if(!isWorldCanonReceipt(receipt))throw new Error("typed receipt expected");
  assertWorldReceiptBasis(f.db,receipt,{historical:true});
  const bytes=readFileSync(join(f.vault,path));
  assertWorldCanonPage(f.db,receipt,bytes,"after");
  const tampered=Buffer.from(bytes.toString("utf8").replace("Bayesian updating","Unadmitted replacement"));
  expect(()=>assertWorldCanonPage(f.db,{...receipt,after_hash:new Bun.CryptoHasher("sha256").update(tampered).digest("hex")},tampered,"after")).toThrow("admitted rendering");
  const lowerPage=parseFrontmatter(bytes.toString("utf8"));lowerPage.data["sensitivity"]="public";
  const lowered=Buffer.from(serializePage(lowerPage));
  expect(()=>assertWorldCanonPage(f.db,{...receipt,before_hash:new Bun.CryptoHasher("sha256").update(lowered).digest("hex"),basis:{...receipt.basis,before:receipt.basis.after}},lowered,"before")).toThrow("classification below admitted basis");
  expect(readFileSync(join(f.vault,path),"utf8")).toContain("Bayesian updating");
  expect(getClaim(f.db,claim.claim_id)!.body).toBe("");
  expect(f.db.query("SELECT COUNT(*) AS n FROM canon_write_intents").get()).toEqual({n:0});
  expect(f.db.query("SELECT COUNT(*) AS n FROM canon_projection_obligations").get()).toEqual({n:0});
 }finally{f.dispose();}
});

import { correct } from "../../src/correction/correct";
import { undoReceipt } from "../../src/canon/undo";
import { loadCanon,pageDecision } from "../../src/serving/canon";
import { OWNER } from "../../src/agents";
import { initSearch } from "../../src/search";
import { initGraph } from "../../src/graph";
test("actual correction rewrites typed canon immediately and undo restores the authorized earlier assertion",async()=>{
 const f=canonFixture();try {
  initSearch(f.db);initGraph(f.db);
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const before=readFileSync(join(f.vault,path),"utf8");
  const changed=await correct(f.io,{statement:"Use prior odds and the likelihood ratio.",target:{claim_id:world.claims[2]!}});
  expect(changed.receipt_id).not.toBeNull();
  expect(readFileSync(join(f.vault,path),"utf8")).toContain("Use prior odds and the likelihood ratio.");
  expect(readFileSync(join(f.vault,path),"utf8")).not.toContain("Revise beliefs using evidence");
  const ctx={db:f.db,vaultPath:f.vault,principal:OWNER},index=loadCanon(ctx);
  expect(pageDecision(index,OWNER.grant,index.byPath.get(path)!).allow).toBe(true);
  const undone=await undoReceipt(f.io,changed.receipt_id!);
  expect(isWorldCanonReceipt(undone)).toBe(true);
  if(isWorldCanonReceipt(undone))assertWorldCanonPage(f.db,undone,readFileSync(join(f.vault,path)),"after");
  expect(readFileSync(join(f.vault,path),"utf8")).toBe(before);
  expect(getClaim(f.db,world.claims[2]!)!.status).toBe("live");
  expect(original.before_hash).toBeNull();
 }finally{f.dispose();}
});

import { runWritePass } from "../../src/serve/write-pass";
import type { ProducerPort } from "../../src/contracts/producer";
test("typed queue materializes admitted claims only inside the configured-model write pass",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db);
  const unconfigured=await runWritePass(f.db,f.vault,{budget:budget()});
  expect(unconfigured.canon_writes).toBe(0);
  expect(world.claims.every(id=>getClaim(f.db,id)!.receipt_id===null)).toBe(true);
  const producer:ProducerPort={descriptor:{id:"kizuki.producer.fixture",kind:"producer",contract:"kizuki.producer/v1",contract_minor:1,supports:["model"],requires_lease:false,optional_package:null},health:async()=>({status:"ready",detail:{}}),close:async()=>{},produce:async()=>({status:"ok",claims:[],usage:{calls:0,input_tokens:0,output_tokens:0},dropped:[]})};
  const result=await runWritePass(f.db,f.vault,{budget:budget(),model_ref:"fixture/model",claims:{db:f.db},producer});
  expect(result.errors).toEqual([]);expect(result.canon_writes).toBe(1);expect(result.claims_written).toBe(3);
  expect(new Set(world.claims.map(id=>getClaim(f.db,id)!.receipt_id)).size).toBe(1);
  const again=await runWritePass(f.db,f.vault,{budget:budget(),model_ref:"fixture/model",claims:{db:f.db},producer});
  expect(again.canon_writes).toBe(0);
 }finally{f.dispose();}
});

import {existsSync} from "node:fs";
import {ABSENT_PAGE_HASH} from "../../src/vault/write";
test("typed create undo and redo preserve exact absent-image semantics and restore the original page",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const bytes=readFileSync(join(f.vault,path));
  const undo=await undoReceipt(f.io,original.receipt_id);
  expect(existsSync(join(f.vault,path))).toBe(false);
  const redo=await undoReceipt(f.io,undo.receipt_id);
  expect(readFileSync(join(f.vault,path))).toEqual(bytes);
  expect(isWorldCanonReceipt(redo)).toBe(true);if(!isWorldCanonReceipt(redo))throw new Error("typed redo expected");
  expect(redo.before_hash).toBe(ABSENT_PAGE_HASH);expect(redo.basis.before).toBeNull();
  assertWorldCanonPage(f.db,redo,null,"before");assertWorldCanonPage(f.db,redo,bytes,"after");
  expect(()=>assertWorldCanonPage(f.db,{...redo,before_hash:null},null,"before")).toThrow("image missing");
  const secondUndo=await undoReceipt(f.io,redo.receipt_id);
  expect(existsSync(join(f.vault,path))).toBe(false);
  expect(isWorldCanonReceipt(secondUndo)).toBe(true);if(!isWorldCanonReceipt(secondUndo))throw new Error("typed second undo expected");
  expect(secondUndo.basis.after).toBeNull();
  const secondRedo=await undoReceipt(f.io,secondUndo.receipt_id);
  expect(readFileSync(join(f.vault,path))).toEqual(bytes);
  expect(isWorldCanonReceipt(secondRedo)).toBe(true);if(!isWorldCanonReceipt(secondRedo))throw new Error("typed second redo expected");
  assertWorldCanonPage(f.db,secondRedo,bytes,"after");
  expect(world.claims.every(id=>getClaim(f.db,id)!.status==="live")).toBe(true);
 }finally{f.dispose();}
});

test("typed redo rejects a hostile absent-before receipt shape without side effects",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const undo=await undoReceipt(f.io,original.receipt_id),redo=await undoReceipt(f.io,undo.receipt_id);
  f.db.query("UPDATE canon_receipts SET page_action='edit' WHERE receipt_id=?").run(redo.receipt_id);
  const bytes=readFileSync(join(f.vault,path)),receiptCount=f.db.query<{count:number},[]>("SELECT COUNT(*) AS count FROM canon_receipts").get()!.count;
  await expect(undoReceipt(f.io,redo.receipt_id)).rejects.toThrow("not undoable");
  expect(readFileSync(join(f.vault,path))).toEqual(bytes);
  expect(f.db.query<{count:number},[]>("SELECT COUNT(*) AS count FROM canon_receipts").get()!.count).toBe(receiptCount);
  expect(readCanonWriteIntent(f.db)).toBeNull();
 }finally{f.dispose();}
});

import {setSourceGrant,inspectSourceGrant} from "../../src/ledger/source-grants";
test("source floor changes stamp both actual typed page bytes and receipt classification",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const source=inspectSourceGrant(f.db,world.sourceKey)!;
  setSourceGrant(f.db,{source_key:world.sourceKey,expected_revision:1,operation_id:"raise-materialization-floor",policy:{...source.policy!,sensitivity_floor:"private"}});
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const receipt=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  expect(receipt.sensitivity).toBe("private");
  expect(isWorldCanonReceipt(receipt)).toBe(true);if(!isWorldCanonReceipt(receipt))throw new Error("typed expected");
  const bytes=readFileSync(join(f.vault,path));expect(parseFrontmatter(bytes.toString("utf8")).data["sensitivity"]).toBe("private");
  assertWorldCanonPage(f.db,receipt,bytes,"after");
 }finally{f.dispose();}
});

test("single typed input owns every newly materialized assertion so undo stays undone",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claim=getClaim(f.db,world.claims[0]!)!;
  const path=worldCanonPath(worldClaimHandle(f.db,claim.claim_id)!);
  const receipt=applyCanonWrite(f.io,claim,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  expect(receipt.claim_ids).toEqual(world.claims);
  expect(world.claims.every(id=>getClaim(f.db,id)!.receipt_id===receipt.receipt_id)).toBe(true);
  await undoReceipt(f.io,receipt.receipt_id);
  expect(world.claims.every(id=>getClaim(f.db,id)!.status==="reverted")).toBe(true);
  const producer:ProducerPort={descriptor:{id:"kizuki.producer.fixture",kind:"producer",contract:"kizuki.producer/v1",contract_minor:1,supports:["model"],requires_lease:false,optional_package:null},health:async()=>({status:"ready",detail:{}}),close:async()=>{},produce:async()=>({status:"ok",claims:[],usage:{calls:0,input_tokens:0,output_tokens:0},dropped:[]})};
  const result=await runWritePass(f.db,f.vault,{budget:budget(),model_ref:"fixture/model",claims:{db:f.db},producer});
  expect(result.errors).toEqual([]);expect(result.canon_writes).toBe(0);expect(existsSync(join(f.vault,path))).toBe(false);
 }finally{f.dispose();}
});

import {FixtureVectorPort} from "../claims/helpers";
import {bindLocalSourcePort} from "../../src/ledger/source-grants";
import {retryCanonProjectionObligations} from "../../src/canon/projection-obligations";
test("typed undo restores exact historical labels while retrieval uses the current higher source floor",async()=>{
 const retrieval=bindLocalSourcePort(new FixtureVectorPort(),{store_id:"local:typed-floor"});
 const f=canonFixture({retrieval,retrieval_store:retrieval.descriptor.id});try {
  initSearch(f.db);initGraph(f.db);
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  await retryCanonProjectionObligations(f.io);
  const bytes=readFileSync(join(f.vault,path)),source=inspectSourceGrant(f.db,world.sourceKey)!;
  setSourceGrant(f.db,{source_key:world.sourceKey,expected_revision:1,operation_id:"raise-undo-floor",policy:{...source.policy!,sensitivity_floor:"private"}});
  const changed=await correct(f.io,{statement:"Use prior odds and the likelihood ratio.",target:{claim_id:world.claims[2]!}});
  await retryCanonProjectionObligations(f.io);
  const undone=await undoReceipt(f.io,changed.receipt_id!);
  expect(readFileSync(join(f.vault,path))).toEqual(bytes);expect(undone.sensitivity).toBe("public");
  expect(isWorldCanonReceipt(undone)).toBe(true);if(!isWorldCanonReceipt(undone))throw new Error("typed undo expected");
  assertWorldCanonPage(f.db,undone,bytes,"after");
  expect(retrieval.docs.get(original.retrieval_ops[0]!.doc)?.sensitivity).toBe("private");
  expect(getClaim(f.db,world.claims[0]!)!.status).toBe("live");expect(getClaim(f.db,world.claims[1]!)!.status).toBe("live");
 }finally{f.dispose();}
});

test("typed receipt authority, confidence, renderer and history provenance remain bound to admitted support",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const receipt=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  if(!isWorldCanonReceipt(receipt))throw new Error("typed receipt expected");
  const bytes=readFileSync(join(f.vault,path));
  for(const patch of [{authority:"owner_correction" as const},{confidence:1},{producer:"owner" as const},{provenance:[]}]) {
    const forged={...receipt,...patch};
    expect(()=>{assertWorldReceiptBasis(f.db,forged,{historical:true});assertWorldCanonPage(f.db,forged,bytes,"after");}).toThrow();
  }
 }finally{f.dispose();}
});

import {getCanonReceipt} from "../../src/canon/receipts";
test("typed correction cannot acquire pre-existing assertions or omit its admitted ownership",async()=>{
 const f=canonFixture();try {
  initSearch(f.db);initGraph(f.db);
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const original=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  if(!isWorldCanonReceipt(original))throw new Error("typed receipt expected");
  expect(()=>assertWorldReceiptBasis(f.db,{...original,claim_ids:[]},{historical:true})).toThrow("ownership");
  const correction=await correct(f.io,{statement:"Use prior odds and the likelihood ratio.",target:{claim_id:world.claims[2]!}});
  const receipt=getCanonReceipt(f.db,correction.receipt_id!)!;
  if(!isWorldCanonReceipt(receipt))throw new Error("typed correction expected");
  const forged={...receipt,claim_ids:[world.claims[0]!,...receipt.claim_ids]};
  expect(()=>assertWorldReceiptBasis(f.db,forged,{historical:true})).toThrow("ownership");
  const bytes=readFileSync(join(f.vault,path));
  f.db.query("UPDATE canon_receipts SET claim_ids=? WHERE receipt_id=?").run(JSON.stringify(forged.claim_ids),receipt.receipt_id);
  await expect(undoReceipt(f.io,receipt.receipt_id)).rejects.toThrow("ownership");
  expect(readFileSync(join(f.vault,path))).toEqual(bytes);
  expect(getClaim(f.db,world.claims[0]!)!.status).toBe("live");
  expect(getClaim(f.db,receipt.claim_ids[0]!)!.status).toBe("live");
  expect(f.db.query("SELECT COUNT(*) AS n FROM canon_write_intents").get()).toEqual({n:0});
  f.db.query("UPDATE canon_receipts SET claim_ids=? WHERE receipt_id=?").run(JSON.stringify(receipt.claim_ids),receipt.receipt_id);
  await undoReceipt(f.io,receipt.receipt_id);
  expect(world.claims.every(id=>getClaim(f.db,id)!.status==="live")).toBe(true);
 }finally{f.dispose();}
});

test("typed reconfirmation owns no earlier claims and remains undoable",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const pageId=f.db.query<{page_id:string},[string]>("SELECT page_id FROM page_index WHERE rel_path=?").get(path)!.page_id;
  const reconfirmed=applyCanonWrite(f.io,claims,{action:"edit",rel_path:path,page_id:pageId,reason:"explicit"},{writer:"loop",budget:budget()});
  expect(reconfirmed.claim_ids).toEqual([]);
  if(!isWorldCanonReceipt(reconfirmed))throw new Error("typed reconfirmation expected");
  assertWorldReceiptBasis(f.db,reconfirmed,{historical:true});
  await undoReceipt(f.io,reconfirmed.receipt_id);
  expect(world.claims.every(id=>getClaim(f.db,id)!.status==="live")).toBe(true);
 }finally{f.dispose();}
});

test("typed revert ownership and images remain bound to the exact recorded target",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const first=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const undone=await undoReceipt(f.io,first.receipt_id);
  if(!isWorldCanonReceipt(undone))throw new Error("typed revert expected");
  expect(()=>assertWorldReceiptBasis(f.db,{...undone,claim_ids:undone.claim_ids.slice(1)},{historical:true})).toThrow("ownership");
  expect(()=>assertWorldReceiptBasis(f.db,{...undone,reverts:undone.receipt_id},{historical:true})).toThrow("ownership");
  const redone=await undoReceipt(f.io,undone.receipt_id);
  if(!isWorldCanonReceipt(redone))throw new Error("typed redo expected");
  assertWorldReceiptBasis(f.db,redone,{historical:true});
  expect(world.claims.every(id=>getClaim(f.db,id)!.status==="live")).toBe(true);
 }finally{f.dispose();}
});
