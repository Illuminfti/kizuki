import type { QualificationProfile, QualificationSample } from "../../src/serve/qualification";
import { DEFAULT_RAILS, RAIL_IDS } from "../../src/serve/types";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { runServeDaemon, readServePid, readServeProcessMarker } from "../../src/serve/daemon";
import { runRail } from "../../src/serve/rails";
import { listSchedules } from "../../src/serve/schema";
import { listRunReceipts } from "../../src/serve/receipts";

test("scheduled, once and manual receipts retain distinct execution identities; brief returns to morning", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-execution-"));
  initVault(root);
  const db = openLedger(join(root, ".kizuki", "kizuki.db"));
  try {
    const manual = await runRail(db, root, "brief", { now: () => "2026-09-05T12:34:00.000Z" });
    expect(manual.execution?.trigger).toBe("manual");
    expect(listSchedules(db).find(row => row.rail === "brief")?.next_run_at).toBe("2026-09-06T07:00:00.000Z");
    await runServeDaemon(db, root, { once: true, rails: ["doctor-sweep"], http: false });
    expect(listRunReceipts(db).find(row => row.rail === "doctor-sweep")?.execution?.trigger).toBe("once");
    db.query("UPDATE schedules SET enabled=0 WHERE rail <> 'sync'").run();
    let ticks = 0;
    await runServeDaemon(db, root, { http: false, shouldContinue: () => ticks++ === 0 });
    const scheduled = listRunReceipts(db).find(row => row.rail === "sync")!;
    expect(scheduled.execution?.trigger).toBe("scheduled");
    expect(scheduled.execution?.due_at).toBeString();
    expect(scheduled.execution?.instance_id).not.toBe(manual.execution?.instance_id);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});


test("daemon marker binds exact instance, remains legacy-readable and preserves a replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-marker-")); initVault(root);
  const db = openLedger(join(root, ".kizuki", "kizuki.db"));
  const path = join(root, ".kizuki", "serve.pid");
  try {
    writeFileSync(path,"123\n"); expect(readServePid(root)).toBe(123); expect(readServeProcessMarker(root)).toBeNull();
    writeFileSync(path,"123garbage"); expect(readServePid(root)).toBeNull();
    let marker: ReturnType<typeof readServeProcessMarker> = null;
    let ticks = 0;
    await runServeDaemon(db,root,{http:false,shouldContinue:()=>{
      marker=readServeProcessMarker(root);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      if(ticks++===0)return true;
      writeFileSync(path,JSON.stringify({...marker,instance_id:"replacement"}));
      return false;
    }});
    const receipt = listRunReceipts(db)[0]!;
    expect(receipt.execution?.instance_id).toBe(marker!.instance_id);
    expect(readServeProcessMarker(root)?.instance_id).toBe("replacement");
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test("JSONL recovery advances the original due slot exactly once despite a late finish", async () => {
 const {persistRunReceipt,recoverRunJournal}=await import("../../src/serve/receipts");
 const {emptyRunTotals}=await import("../../src/serve/types");
 const root=mkdtempSync(join(tmpdir(),"kizuki-schedule-replay-"));initVault(root);
 const db=openLedger(join(root,".kizuki/kizuki.db"));
 const due="2026-09-05T00:00:00.000Z",finished="2026-09-05T00:00:30.000Z";
 try {
  db.query("UPDATE schedules SET next_run_at=?, period_s=60 WHERE rail='embed-backfill'").run(due);
  const receipt={...emptyRunTotals(),run_id:"replay-grid",rail:"embed-backfill",started_at:due,finished_at:finished,status:"ok" as const,stopped:null,execution:{instance_id:"a",pid:12,boot_id:"boot",trigger:"scheduled" as const,due_at:due}};
  expect(()=>persistRunReceipt(db,root,receipt,{crashAfter:"after-jsonl"})).toThrow();
  expect(recoverRunJournal(db,root)).toEqual(["replay-grid"]);
  const next=()=>listSchedules(db).find(r=>r.rail==="embed-backfill")!.next_run_at;
  expect(next()).toBe("2026-09-05T00:01:00.000Z");
  expect(recoverRunJournal(db,root)).toEqual([]);expect(next()).toBe("2026-09-05T00:01:00.000Z");
  const {evaluateQualification}=await import("../../src/serve/qualification");
  const profile:QualificationProfile={scope:"fixture",start_at:due,boot_id:"boot",monotonic_ms:0,brief_hour:7,timezone:"UTC",supervisor:"none",sampling_interval_ms:30_000,max_gap_ms:60_000,lateness_ms:30_000,rails:DEFAULT_RAILS.map(spec=>({...spec,next_run_at:spec.rail==="embed-backfill"?due:new Date(Date.parse(due)+spec.period_s*1000).toISOString()}))};
  const recovered=listRunReceipts(db)[0]!;
  const first:QualificationSample={at:finished,monotonic_ms:30_000,boot_id:"boot",supervisor:"not-observed",process:{pid:12,boot_id:"boot",start_ticks:"1",binary_sha256:"a".repeat(64),instance_id:"a"},issues:[],receipts:[{run_id:recovered.run_id,sha256:"b".repeat(64),rail:recovered.rail,started_at:recovered.started_at,finished_at:recovered.finished_at,status:recovered.status,healthy:true,execution:recovered.execution!}]};
  const restarted={...receipt,run_id:"restart-grid",started_at:next()!,finished_at:"2026-09-05T00:01:30.000Z",execution:{...receipt.execution,instance_id:"b",pid:13,due_at:next()!}};
  persistRunReceipt(db,root,restarted);
  const second:QualificationSample={...first,at:restarted.finished_at,monotonic_ms:90_000,process:{...first.process!,pid:13,start_ticks:"2",instance_id:"b"},receipts:[{...first.receipts[0]!,run_id:restarted.run_id,sha256:"c".repeat(64),started_at:restarted.started_at,finished_at:restarted.finished_at,execution:restarted.execution}]};
  const evaluated=evaluateQualification(profile,[first,second]);
  expect(evaluated.issues).toEqual([]);expect(evaluated.automatic_runs).toBe(2);expect(evaluated.process_restarts).toBe(1);

 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});


test("forged schedule transitions cannot rewrite the persisted due boundary", async () => {
 const {persistRunReceipt,recoverRunJournal}=await import("../../src/serve/receipts");
 const {emptyRunTotals}=await import("../../src/serve/types");
 const root=mkdtempSync(join(tmpdir(),"kizuki-schedule-forged-"));initVault(root);
 const db=openLedger(join(root,".kizuki/kizuki.db"));
 const due="2026-09-05T00:00:00.000Z";
 try {
  db.query("UPDATE schedules SET next_run_at=?, period_s=60 WHERE rail='doctor-sweep'").run(due);
  const receipt={...emptyRunTotals(),run_id:"forged-grid",rail:"doctor-sweep",started_at:due,finished_at:due,status:"ok" as const,stopped:null,execution:{instance_id:"a",pid:12,boot_id:"boot",trigger:"scheduled" as const,due_at:due}};
  expect(()=>persistRunReceipt(db,root,receipt,{crashAfter:"after-jsonl"})).toThrow();
  const path=join(root,".kizuki/run-receipts.jsonl"),original=readFileSync(path,"utf8");
  for(const field of ["next_run_at","previous_due_at","period_s"]){
   const row=JSON.parse(original);row.schedule_transition[field]=field==="period_s"?600:"2099-01-01T00:00:00.000Z";
   writeFileSync(path,JSON.stringify(row)+"\n");expect(()=>recoverRunJournal(db,root)).toThrow("conflicting");
   expect(listSchedules(db).find(r=>r.rail==="doctor-sweep")!.next_run_at).toBe(due);
   expect(listRunReceipts(db)).toHaveLength(0);
  }
  writeFileSync(path,original);expect(recoverRunJournal(db,root)).toEqual(["forged-grid"]);
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
