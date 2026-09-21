import { expect,test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonFixture,budget } from "./helpers";
import { worldFixture } from "../serving/world-fixture";
import { getClaim } from "../../src/claims/store";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldClaimHandle,worldCanonPath } from "../../src/canon/world-materialization";
import { isWorldCanonReceipt } from "../../src/canon/world-receipt";

test("real admitted typed claims render through the same canon writer while their legacy parents stay neutral",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db);
  const claim=getClaim(f.db,world.claims[0]!)!,path=worldCanonPath(worldClaimHandle(f.db,claim.claim_id)!);
  expect(claim.body).toBe("");expect(claim.subject).toBeNull();
  const receipt=applyCanonWrite(f.io,claim,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  expect(isWorldCanonReceipt(receipt)).toBe(true);
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
