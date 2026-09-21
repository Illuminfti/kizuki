import {test,expect} from "bun:test";
import {existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {canonFixture,budget} from "./helpers";
import {worldFixture} from "../serving/world-fixture";
import {getClaim} from "../../src/claims/store";
import {applyCanonWrite} from "../../src/canon/apply";
import {worldClaimHandle,worldCanonPath} from "../../src/canon/world-materialization";
import {correct} from "../../src/correction/correct";
import {initSearch} from "../../src/search";
import {initGraph} from "../../src/graph";
import {OWNER,addAgent,authenticate} from "../../src/agents";
import {loadCanon,pageDecision} from "../../src/serving/canon";
import {revokeSourceGrant} from "../../src/ledger/source-grants";
import {ensureLedgerSchema,openLedger} from "../../src/ledger/db";
import {applyCanonV4} from "../../src/canon/schema";
import {runPurge} from "../../src/ledger/purge";
import {getCanonReceiptRecord,isErasedReceipt} from "../../src/canon/receipts";
import {readCanonWriteIntent} from "../../src/canon/write-intent";
import {tempVault} from "../helpers/vault";
import {recoverCanonWrites} from "../../src/canon/recovery";
import {undoReceipt} from "../../src/canon/undo";
import {parseWorldAdmission} from "../../src/contracts/world-admission";
import {insertClaim} from "../../src/claims/store";
import {worldReceiptChain} from "../../src/canon/receipts";

test("typed reads use the actual relay grant and reject source withdrawal",async()=>{
 const f=canonFixture();try {
  initSearch(f.db);initGraph(f.db);
  const w=await worldFixture(f.db),claims=w.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  await correct(f.io,{statement:"Use prior odds and the likelihood ratio.",target:{claim_id:w.claims[2]!}});
  const deniedAgent=addAgent(f.db,"review-no-relay",{...OWNER.grant,relay_owner_corrections:false});
  const ctx={db:f.db,vaultPath:f.vault,principal:authenticate(f.db,deniedAgent.token)!};
  const denied=loadCanon(ctx),page=denied.byPath.get(path)!;
  expect(pageDecision(denied,ctx.principal.grant,page).allow).toBe(false);
  const allowedAgent=addAgent(f.db,"review-relay",{...OWNER.grant,relay_owner_corrections:true});
  const grantedCtx={...ctx,principal:authenticate(f.db,allowedAgent.token)!};
  const granted=loadCanon(grantedCtx);
  expect(pageDecision(granted,grantedCtx.principal.grant,granted.byPath.get(path)!).allow).toBe(true);
  revokeSourceGrant(f.db,{source_key:w.sourceKey,expected_revision:1,operation_id:"review-withdraw"});
  const withdrawn=loadCanon(grantedCtx);
  expect(pageDecision(withdrawn,grantedCtx.principal.grant,withdrawn.byPath.get(path)!).allow).toBe(false);
 }finally{f.dispose();}
});

test("migration failure rolls back table rebuild and restores foreign-key enforcement",()=>{
 const db=new Database(":memory:");try {
  ensureLedgerSchema(db);
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("DROP TABLE canon_receipts");applyCanonV4(db);
  db.exec("UPDATE schema_version SET version=32");
  db.exec("CREATE TABLE review_child(receipt_id TEXT REFERENCES canon_receipts(receipt_id) ON DELETE RESTRICT)");
  db.exec("INSERT INTO review_child VALUES ('missing-receipt')");
  db.exec("PRAGMA foreign_keys=ON");
  expect(()=>ensureLedgerSchema(db)).toThrow("typed canon migration changed receipt identity");
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({foreign_keys:1});
  expect(db.query("SELECT version FROM schema_version").get()).toEqual({version:32});
  expect(db.query<{name:string},[]>("PRAGMA table_info(canon_receipts)").all().map(row=>row.name)).not.toContain("record_codec");
  expect(db.query("SELECT * FROM review_child").all()).toEqual([{receipt_id:"missing-receipt"}]);
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name='canon_receipts_v5'").get()).toBeNull();
  expect(()=>db.exec("INSERT INTO review_child VALUES ('another-missing')")).toThrow("FOREIGN KEY constraint failed");
 }finally{db.close();}
});

test("reopening a file-backed ledger recovers redacted typed erasure exactly once",async()=>{
 const vault=tempVault("review-typed-reopen-");let db=openLedger(join(vault.path,".kizuki/kizuki.db"));try {
  const world=await worldFixture(db),claims=world.claims.map(id=>getClaim(db,id)!);
  const path=worldCanonPath(worldClaimHandle(db,claims[0]!.claim_id)!);
  const original=applyCanonWrite({db,vault_path:vault.path},claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  db.exec("CREATE TRIGGER review_restart_interrupt BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(ABORT,'review restart interruption'); END");
  await expect(runPurge(db,vault.path,{event_id:world.eventId},"review restart erasure")).rejects.toThrow("review restart interruption");
  const receiptId=readCanonWriteIntent(db)!.receipt.receipt_id;
  db.close();db=openLedger(join(vault.path,".kizuki/kizuki.db"));
  expect(existsSync(join(vault.path,path))).toBe(false);
  db.exec("DROP TRIGGER review_restart_interrupt");
  expect(recoverCanonWrites({db,vault_path:vault.path}).completed).toEqual([receiptId]);
  expect(recoverCanonWrites({db,vault_path:vault.path}).completed).toEqual([]);
  expect(isErasedReceipt(getCanonReceiptRecord(db,original.receipt_id)!)).toBe(true);
  const log=readFileSync(join(vault.path,".kizuki/receipts/promotions.jsonl"),"utf8");
  expect(log.trim().split("\n").filter(line=>JSON.parse(line).receipt_id===receiptId)).toHaveLength(1);
  expect(log).not.toContain(world.eventId);expect(log).not.toContain(original.after_hash);
 }finally{db.close();vault.dispose();}
});

test("typed undo requires the current admitted basis when bytes are unchanged, then cascades safely",async()=>{
 const f=canonFixture();try {
  const world=await worldFixture(f.db),claims=world.claims.map(id=>getClaim(f.db,id)!);
  const path=worldCanonPath(worldClaimHandle(f.db,claims[0]!.claim_id)!);
  const first=applyCanonWrite(f.io,claims,{action:"create",rel_path:path},{writer:"loop",budget:budget()});
  const admission=parseWorldAdmission(JSON.parse(f.db.query<{admission:string},[string]>("SELECT admission FROM claim_v2_support WHERE claim_id=?").get(world.claims[2]!)!.admission))!;
  const semantic={...admission.semantic,object:{kind:"literal" as const,value:"Additional source assertion."}};
  const inserted=await insertClaim({db:f.db},{kind:"claim",body:"",provenance:[world.eventId],producer:"deterministic",confidence:0.8,semantic,world_admission:{...admission,semantic,rendering:{body:"",frontmatter:{}}}});
  if(inserted.outcome!=="stored")throw new Error("expected admitted typed assertion");
  const pageId=f.db.query<{page_id:string},[string]>("SELECT page_id FROM page_index WHERE rel_path=?").get(path)!.page_id;
  const second=applyCanonWrite(f.io,inserted.claim,{action:"edit",rel_path:path,page_id:pageId,reason:"explicit"},{writer:"loop",budget:budget()});
  expect(second.after_hash).toBe(first.after_hash);
  const bytes=readFileSync(join(f.vault,path));
  const before=worldReceiptChain(f.db,path).map(receipt=>receipt.receipt_id);
  await expect(undoReceipt(f.io,first.receipt_id)).rejects.toThrow("page changed");
  expect(readFileSync(join(f.vault,path))).toEqual(bytes);
  expect(worldReceiptChain(f.db,path).map(receipt=>receipt.receipt_id)).toEqual(before);
  expect(readCanonWriteIntent(f.db)).toBeNull();
  await undoReceipt(f.io,first.receipt_id,{cascade:true});
  expect(existsSync(join(f.vault,path))).toBe(false);
  const last=worldReceiptChain(f.db,path).at(-1)!;
  if(isErasedReceipt(last))throw new Error("cascade must retain its undo receipt");
  expect(last.basis.after).toBeNull();
 }finally{f.dispose();}
});
