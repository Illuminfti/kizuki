import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { applyCanonWrite } from "../../src/canon/apply";
import { recoverCanonWrites } from "../../src/canon/recovery";
import { getCanonReceipt } from "../../src/canon/receipts";
import { undoReceipt } from "../../src/canon/undo";
import { readCanonWriteIntent } from "../../src/canon/write-intent";
import { isWorldCanonReceipt } from "../../src/canon/world-receipt";
import { assertRetainedWorldBasis, assertWorldReceiptBasis, worldBasisAllowed, worldCanonTarget } from "../../src/canon/world-materialization";
import { getClaim } from "../../src/claims/store";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { accept, readEvent, liveEventIds } from "../../src/ledger/ledger";
import { inspectSourceGrant, revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { loadCanon, pageDecision } from "../../src/serving/canon";
import { serveGetPage } from "../../src/serving/page";
import { serveSearch } from "../../src/serving/search";
import { serveWorldView } from "../../src/serving/world-view";
import { validEvent } from "../fixtures";
import { worldSeed } from "../helpers/world-seed";
import { budget, canonFixture } from "./helpers";

async function fixture() {
  const f = canonFixture();
  const seed = await worldSeed(f.db,{predicates:[
    {predicate:"concept.definition",object:{kind:"literal",value:"Revise beliefs using evidence"}},
    {predicate:"concept.example",object:{kind:"literal",value:"Retired source-only example"}},
  ]});
  const claims = seed.claims.map(id => getClaim(f.db,id)!);
  const first = applyCanonWrite(f.io,claims,worldCanonTarget(f.db,claims[0]!.claim_id),{writer:"loop",budget:budget()});
  if(!isWorldCanonReceipt(first))throw new Error("typed receipt missing");
  const ctx = {db:f.db,vaultPath:f.vault,principal:OWNER};
  expect(serveGetPage(ctx,{path:first.page_path}).canon).toHaveLength(1);
  expect((await serveSearch(ctx,{query:"Retired source-only example",scope:"canon"})).canon.length).toBeGreaterThan(0);
  const event = readEvent(f.db,seed.eventId)!;
  const tombstone = accept(f.db,{...validEvent(),connector_id:event.connector_id,source_record_id:event.source_record_id,
    occurred_at:"2030-01-01T00:00:00.000Z",deleted:true,text:"",subjects:event.subjects,sensitivity_hint:"public"},
    {source:{source_key:seed.sourceKey,expected_revision:1}});
  expect(tombstone.status).toBe("stored");
  expect(liveEventIds(f.db,[seed.eventId]).size).toBe(0);
  return {...f,seed,first,ctx};
}
function visible(f:Awaited<ReturnType<typeof fixture>>) {
  const index=loadCanon(f.ctx), page=index.byPath.get(f.first.page_path);
  return page!==undefined && pageDecision(index,OWNER.grant,page).allow;
}
async function fresh(f:Awaited<ReturnType<typeof fixture>>) {
  const next=await worldSeed(f.db,{sourceKey:f.seed.sourceKey});
  const claims=next.claims.map(id=>getClaim(f.db,id)!);
  return {next,write:()=>applyCanonWrite(f.io,claims,worldCanonTarget(f.db,claims[0]!.claim_id),{writer:"loop",budget:budget()})};
}

test("retained tombstoned support proves custody but cannot serve, undo, or leak through history",async()=>{
  const f=await fixture();try {
    expect(()=>assertRetainedWorldBasis(f.db,f.first.basis.after)).not.toThrow();
    expect(()=>assertWorldReceiptBasis(f.db,f.first,{proof:"receipt_custody"})).not.toThrow();
    expect(worldBasisAllowed(f.ctx,f.first.basis.after,true)).toBe(false);
    expect(visible(f)).toBe(false);
    const history=serveWorldView(f.ctx,{operation:"history",concept:f.seed.ref,valid:{kind:"all"},knownAt:{kind:"current"}});
    expect(history.data).toEqual({status:"not_found"});
    expect(JSON.stringify(history)).not.toContain(f.seed.label);
    await expect(undoReceipt(f.io,f.first.receipt_id)).rejects.toThrow("world support changed");
    const restored=await fresh(f), second=restored.write();
    if(!isWorldCanonReceipt(second))throw new Error("typed receipt missing");
    expect(second.basis.before).toEqual(f.first.basis.after);
    expect(second.basis.after).not.toEqual(second.basis.before);
    expect(worldBasisAllowed(f.ctx,second.basis.after)).toBe(true);
    expect(visible(f)).toBe(true);
    const bytes=readFileSync(join(f.vault,second.page_path));
    expect(bytes.toString()).toContain(restored.next.eventId);
    expect(bytes.toString()).not.toContain(f.seed.eventId);
    expect(bytes.toString()).not.toContain("Retired source-only example");
    await expect(undoReceipt(f.io,second.receipt_id)).rejects.toThrow("world support changed");
    expect(readFileSync(join(f.vault,second.page_path))).toEqual(bytes);
    expect(readCanonWriteIntent(f.db)).toBeNull();
    expect(liveEventIds(f.db,[f.seed.eventId]).size).toBe(0);
  }finally{f.dispose();}
});

for(const denial of ["narrow","revoke"] as const)test(`receipt custody still rejects current source ${denial}`,async()=>{
  const f=await fixture();try {
    expect(()=>assertRetainedWorldBasis(f.db,f.first.basis.after)).not.toThrow();
    if(denial==="revoke")revokeSourceGrant(f.db,{source_key:f.seed.sourceKey,expected_revision:1,operation_id:"custody-revoke"});
    else setSourceGrant(f.db,{source_key:f.seed.sourceKey,expected_revision:1,operation_id:"custody-narrow",
      policy:{...inspectSourceGrant(f.db,f.seed.sourceKey)!.policy,allowed_fields:["subjects","metadata","attachments"]}});
    expect(()=>assertRetainedWorldBasis(f.db,f.first.basis.after)).toThrow();
    expect(()=>assertWorldReceiptBasis(f.db,f.first,{proof:"receipt_custody"})).toThrow();
    expect(visible(f)).toBe(false);
  }finally{f.dispose();}
});

test("a fresh-source replacement recovers its existing write intent exactly once",async()=>{
  const f=await fixture();try {
    const restored=await fresh(f);
    f.db.exec("CREATE TRIGGER custody_interrupt BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(ABORT,'synthetic custody interruption'); END");
    expect(restored.write).toThrow("synthetic custody interruption");
    const pending=readCanonWriteIntent(f.db)!;
    expect(pending).not.toBeNull();
    f.db.exec("DROP TRIGGER custody_interrupt");
    expect(recoverCanonWrites(f.io).completed).toEqual([pending.receipt.receipt_id]);
    expect(recoverCanonWrites(f.io).completed).toEqual([]);
    expect(getCanonReceipt(f.db,pending.receipt.receipt_id)).not.toBeNull();
    expect(visible(f)).toBe(true);
    expect(liveEventIds(f.db,[f.seed.eventId]).size).toBe(0);
  }finally{f.dispose();}
});

test("backup restore validates tombstoned receipt history without reviving its evidence",async()=>{
  const f=await fixture(), root=mkdtempSync(join(tmpdir(),"kizuki-custody-backup-"));try {
    const restored=await fresh(f), second=restored.write();
    const backup=join(root,"backup"),target=join(root,"restored");
    exportVault(f.db,f.vault,backup);restoreVault(backup,target);
    const db=openLedger(join(target,".kizuki/kizuki.db"));try {
      expect(getCanonReceipt(db,f.first.receipt_id)).toEqual(f.first);
      expect(getCanonReceipt(db,second.receipt_id)).toEqual(second);
      expect(liveEventIds(db,[f.seed.eventId]).size).toBe(0);
      expect(worldBasisAllowed({db,vaultPath:target,principal:OWNER},f.first.basis.after,true)).toBe(false);
      expect(readFileSync(join(target,second.page_path))).toEqual(readFileSync(join(f.vault,second.page_path)));
      await expect(undoReceipt({db,vault_path:target},second.receipt_id)).rejects.toThrow("world support changed");
    }finally{db.close();}
  }finally{f.dispose();rmSync(root,{recursive:true,force:true});}
});

test("a restored tombstoned head stays invisible to public page and world readers",async()=>{
  const f=await fixture(),root=mkdtempSync(join(tmpdir(),"kizuki-custody-hidden-backup-"));try {
    const backup=join(root,"backup"),target=join(root,"restored");
    exportVault(f.db,f.vault,backup);restoreVault(backup,target);
    const db=openLedger(join(target,".kizuki/kizuki.db"));try {
      const ctx={db,vaultPath:target,principal:OWNER};
      expect(()=>assertWorldReceiptBasis(db,f.first,{proof:"receipt_custody"})).not.toThrow();
      const index=loadCanon(ctx),page=index.byPath.get(f.first.page_path);
      expect(page===undefined||!pageDecision(index,OWNER.grant,page).allow).toBe(true);
      expect(serveGetPage(ctx,{path:f.first.page_path}).canon).toEqual([]);
      expect((await serveSearch(ctx,{query:"Retired source-only example",scope:"canon"})).canon).toEqual([]);
      const discovery=serveWorldView(ctx,{operation:"find_concepts",label:f.seed.label,valid:{kind:"all"},knownAt:{kind:"current"}});
      expect(discovery.data).toMatchObject({result:{data:{matches:[]}}});
      expect(liveEventIds(db,[f.seed.eventId]).size).toBe(0);
    }finally{db.close();}
  }finally{f.dispose();rmSync(root,{recursive:true,force:true});}
});

test("source withdrawal during an interrupted replacement keeps its existing recovery fence",async()=>{
  const f=await fixture();try {
    const restored=await fresh(f);
    f.db.exec("CREATE TRIGGER custody_interrupt BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(ABORT,'synthetic custody interruption'); END");
    expect(restored.write).toThrow("synthetic custody interruption");
    const pending=readCanonWriteIntent(f.db)!;
    f.db.exec("DROP TRIGGER custody_interrupt");
    setSourceGrant(f.db,{source_key:f.seed.sourceKey,expected_revision:1,operation_id:"custody-pending-narrow",
      policy:{...inspectSourceGrant(f.db,f.seed.sourceKey)!.policy,purposes:["capture"]}});
    expect(()=>recoverCanonWrites(f.io)).toThrow();
    expect(readCanonWriteIntent(f.db)?.receipt.receipt_id).toBe(pending.receipt.receipt_id);
    expect(getCanonReceipt(f.db,pending.receipt.receipt_id)).toBeNull();
    expect(visible(f)).toBe(false);
    expect(liveEventIds(f.db,[f.seed.eventId]).size).toBe(0);
  }finally{f.dispose();}
});
