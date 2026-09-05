import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, symlinkSync, statSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checksumManifest } from "./release-artifacts";
import { initQualification, sampleQualification, statusQualification, strictReceiptProjection } from "./qualification";
import { initVault } from "../packages/core/src/vault/init";
import { openLedger } from "../packages/core/src/ledger/db";
import { initServe } from "../packages/core/src/serve/schema";
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),"kizuki-qualification-test-"));dirs.push(root);
 const artifact=join(root,"artifact"),vault=join(root,"vault"),proof=join(root,"proof.json"),scope=join(root,"scope.json"),out=join(root,"report");
 mkdirSync(artifact);initVault(vault);const db=openLedger(join(vault,".kizuki/kizuki.db"));initServe(db);db.query("UPDATE schedules SET next_run_at = ?").run(new Date().toISOString());db.close();
 writeFileSync(join(vault,".kizuki/run-receipts.jsonl"),"");
 for(const name of ["kizuki","kizuki-mcp","README.txt"])writeFileSync(join(artifact,name),"synthetic artifact fixture: never executed");
 writeFileSync(join(artifact,"BUILD.json"),JSON.stringify({schema:"kizuki.release-build/v1",source_sha:"a".repeat(40),target:"bun-linux-x64-baseline",bun_version:"1.3.10"}));
 writeFileSync(join(artifact,"SHA256SUMS"),checksumManifest(artifact,["kizuki","kizuki-mcp","README.txt","BUILD.json"]));
 const ids=["help","init","import","query","query-result","context","context-result","export","restore-verify","restore","restored-query","restored-query-result","restored-context","restored-context-result"];
 writeFileSync(proof,JSON.stringify({schema:"kizuki.artifact-proof/v1",source_sha:"a".repeat(40),target:"bun-linux-x64-baseline",binary_sha256:createHash("sha256").update(readFileSync(join(artifact,"kizuki"))).digest("hex"),failures:[],steps:ids.map(id=>({id,passed:true,exit_code:0}))}));
 writeFileSync(scope,JSON.stringify({scope:"fixture",vault,brief_hour:7,timezone:"UTC",supervisor:"none"}));
 return{root,artifact,vault,proof,scope,out};
}
test("init binds proof/build/checksums, uses private files and refuses overwrite",()=>{
 const f=fixture();expect(initQualification(f.artifact,f.proof,f.scope,f.out).status).toBe("awaiting-observation");
 expect(statSync(f.out).mode & 0o777).toBe(0o700);expect(statSync(join(f.out,"manifest.json")).mode & 0o777).toBe(0o600);
 expect(()=>initQualification(f.artifact,f.proof,f.scope,f.out)).toThrow();
 expect(statusQualification(f.out).identity.source_sha).toBe("a".repeat(40));
});
test("mismatched proof, owner scope and symlink paths are refused before report creation",()=>{
 const f=fixture();const original=readFileSync(f.proof,"utf8");writeFileSync(f.proof,original.replace('"source_sha":"'+"a".repeat(40),'"source_sha":"'+"b".repeat(40)));
 expect(()=>initQualification(f.artifact,f.proof,f.scope,f.out)).toThrow("proof");writeFileSync(f.proof,original);
 writeFileSync(f.scope,JSON.stringify({scope:"owner-estate",vault:f.vault,brief_hour:7}));expect(()=>initQualification(f.artifact,f.proof,f.scope,f.out)).toThrow("fixture");
 writeFileSync(f.scope,JSON.stringify({scope:"fixture",vault:f.vault,brief_hour:7,timezone:"UTC",supervisor:"none"}));const alias=join(f.root,"alias");symlinkSync(f.artifact,alias);expect(()=>initQualification(alias,f.proof,f.scope,f.out)).toThrow("symlink");
});
test("separate real subprocess samples preserve actual time and never turn fixtures into qualification",async()=>{
 const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);
 const invoke=()=>{const result=Bun.spawnSync([process.execPath,join(import.meta.dir,"qualification.ts"),"sample","--run",f.out]);expect(result.exitCode).toBe(0);return JSON.parse(result.stdout.toString());};
 invoke();await Bun.sleep(1100);const second=invoke();
 expect(second.observed_ms).toBeGreaterThanOrEqual(1000);expect(second.observed_ms).toBeLessThan(60_000);expect(second.release_qualified).toBe(false);
 expect(second.issues).toContain("process-unverified");expect(statusQualification(f.out).samples).toBe(2);
 const journal=readFileSync(join(f.out,"samples.jsonl"),"utf8");appendFileSync(join(f.out,"samples.jsonl"),"{");expect(()=>statusQualification(f.out)).toThrow("torn");
 writeFileSync(join(f.out,"samples.jsonl"),journal.replace('"seq":0','"seq":9'));expect(()=>statusQualification(f.out)).toThrow("hash chain");
});
test("strict collector refuses corruption and retains only content-free receipt fields",()=>{
 const receipt={run_id:"01K00000000000000000000000",rail:"sync",started_at:"2026-09-05T00:00:00.000Z",finished_at:"2026-09-05T00:00:01.000Z",status:"ok",model:{unavailable:0},retrieval:{degraded:[]},errors:["PRIVATE SOURCE SHOULD NOT BE COPIED"]};
 const rows=strictReceiptProjection(JSON.stringify(receipt)+"\n");expect(JSON.stringify(rows)).not.toContain("PRIVATE SOURCE");expect(rows[0]!.execution).toBeNull();
 expect(()=>strictReceiptProjection(JSON.stringify(receipt))).toThrow("torn");expect(()=>strictReceiptProjection("bad\n")).toThrow();
 expect(()=>strictReceiptProjection(JSON.stringify({...receipt,execution:{pid:1}})+"\n")).toThrow("identity");
});
test("artifact changes and stale collector locks refuse further appends",()=>{
 const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);writeFileSync(join(f.out,"sample.lock"),"crashed collector evidence");expect(()=>sampleQualification(f.out)).toThrow();
 rmSync(join(f.out,"sample.lock"));appendFileSync(join(f.artifact,"kizuki"),"changed");expect(()=>sampleQualification(f.out)).toThrow("durable interruption");expect(readFileSync(join(f.out,"samples.jsonl"),"utf8")).toContain("collection-rejected");
});
test("captured receipt hashes survive operational prune and a conflict stays durably interrupted",()=>{
 const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);
 const now=new Date().toISOString();
 const receipt={run_id:"01K00000000000000000000001",rail:"sync",started_at:now,finished_at:now,status:"ok",errors:[],model:{unavailable:0},retrieval:{degraded:[]}};
 const journal=join(f.vault,".kizuki/run-receipts.jsonl");writeFileSync(journal,JSON.stringify(receipt)+"\n");sampleQualification(f.out);
 writeFileSync(journal,"");sampleQualification(f.out);
 expect(readFileSync(join(f.out,"samples.jsonl"),"utf8")).toContain('"run_id":"01K00000000000000000000001"');
 writeFileSync(journal,JSON.stringify({...receipt,status:"failed"})+"\n");expect(()=>sampleQualification(f.out)).toThrow("durable interruption");
 writeFileSync(journal,"");expect(sampleQualification(f.out).issues).toContain("collection-rejected");
});

test("extra execution fields cannot enter content-minimal evidence", () => {
 const receipt={run_id:"01K00000000000000000000000",rail:"sync",started_at:"2026-09-05T00:00:00.000Z",finished_at:"2026-09-05T00:00:01.000Z",status:"ok",model:{unavailable:0},retrieval:{degraded:[]},errors:[],execution:{instance_id:"i",pid:1,boot_id:"b",trigger:"scheduled",due_at:"2026-09-05T00:00:00.000Z",private_note:"SECRET_SENTINEL"}};
 expect(()=>strictReceiptProjection(JSON.stringify(receipt)+"\n")).toThrow("execution");
});

test("actual retained receipt prune preserves canonical evidence; semantic changes conflict", async () => {
 const {persistRunReceipt,pruneRunReceipts}=await import("../packages/core/src/serve/receipts");
 const {emptyRunTotals}=await import("../packages/core/src/serve/types");
 const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);
 const now=new Date().toISOString(), db=openLedger(join(f.vault,".kizuki/kizuki.db"));
 try {
  persistRunReceipt(db,f.vault,{...emptyRunTotals(),run_id:"01K00000000000000000000002",rail:"doctor-sweep",started_at:now,finished_at:now,status:"ok",stopped:null});
  sampleQualification(f.out);
  pruneRunReceipts(db,f.vault,now);
  expect(()=>sampleQualification(f.out)).not.toThrow();
  const journal=join(f.vault,".kizuki/run-receipts.jsonl");
  const row=JSON.parse(readFileSync(journal,"utf8")); row.events_stored=1;
  writeFileSync(journal,JSON.stringify(row)+"\n");
  expect(()=>sampleQualification(f.out)).toThrow("durable interruption");
 } finally {db.close();}
});

test("init anchors manifest before sample one and rejects in-place policy edits", () => {
 const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);
 const path=join(f.out,"manifest.json");const manifest=JSON.parse(readFileSync(path,"utf8"));
 manifest.profile.brief_hour=8;writeFileSync(path,JSON.stringify(manifest)+"\n");
 expect(()=>statusQualification(f.out)).toThrow("manifest");
});


test("genesis freezes qualification ID, policy digest, manifest schema and file identity at init", () => {
 const f=fixture();const initial=initQualification(f.artifact,f.proof,f.scope,f.out);
 const path=join(f.out,"manifest.json"),original=readFileSync(path,"utf8"),manifest=JSON.parse(original);
 const genesis=JSON.parse(readFileSync(join(f.out,"genesis.json"),"utf8"));
 expect(initial.qualification_id).toBe(genesis.qualification_id);
 expect(initial.policy_sha256).toBe(genesis.policy_sha256);
 expect(manifest.profile).toMatchObject({timezone:"UTC",supervisor:"none",sampling_interval_ms:30_000});
 expect(statusQualification(f.out)).toMatchObject({owner_morning:"unqualified",supervised_pilot:"unqualified",rail_qualification:"fixture-only",samples:0});
 writeFileSync(path,JSON.stringify({...manifest,extra:"PRIVATE_SENTINEL"}));expect(()=>statusQualification(f.out)).toThrow("schema");
 writeFileSync(path,original);
 // Keep old inode allocated so replacement identity cannot be reused.
 const previous=join(f.out,"old-manifest.json");renameSync(path,previous);writeFileSync(path,original);
 expect(()=>statusQualification(f.out)).toThrow("manifest genesis");
});

test("non-UTC and supervised scopes are refused rather than credited as fixture morning", () => {
 for(const change of [{timezone:"America/New_York"},{supervisor:"systemd"}]) {
  const f=fixture();const scope=JSON.parse(readFileSync(f.scope,"utf8"));writeFileSync(f.scope,JSON.stringify({...scope,...change}));
  expect(()=>initQualification(f.artifact,f.proof,f.scope,f.out)).toThrow("UTC fixture");
 }
});

test("canonical receipt digest preserves semantic counters and ignores JSON key ordering only", () => {
 const receipt={run_id:"01K00000000000000000000003",rail:"sync",started_at:"2026-09-05T00:00:00.000Z",finished_at:"2026-09-05T00:00:01.000Z",status:"ok",model:{unavailable:0},retrieval:{degraded:[]},errors:[],claims_rejected:{b:2,a:1}};
 const projection=(value:unknown)=>strictReceiptProjection(JSON.stringify(value)+"\n")[0]!;
 expect(projection(receipt).sha256).toBe(projection({...receipt,claims_rejected:{a:1,b:2}}).sha256);
 expect(projection(receipt).sha256).not.toBe(projection({...receipt,events_stored:1}).sha256);
 expect(()=>projection({...receipt,events_stored:"1"})).toThrow("counter");
 expect(projection(receipt).sha256).not.toBe(projection({...receipt,model:{...receipt.model,usage_unknown:true}}).sha256);
});

test("strict projection accepts producer identifiers and rejects private values in each identity field", () => {
 const execution = {instance_id:"12345678-1234-4123-8123-123456789abc",boot_id:"12345678-1234-4123-8123-123456789abd",pid:12,trigger:"scheduled",due_at:"2026-09-05T00:00:00.000Z"};
 const receipt={run_id:"01K00000000000000000000000",rail:"sync",started_at:execution.due_at,finished_at:execution.due_at,status:"ok",errors:[],model:{unavailable:0},retrieval:{degraded:[]},execution};
 expect(strictReceiptProjection(JSON.stringify(receipt)+"\n")[0]!.run_id).toBe(receipt.run_id);
 for (const bad of ["PRIVATE_SOURCE_SENTINEL", "", "01k00000000000000000000000", "81K0000000000000000000000"]) {
  expect(()=>strictReceiptProjection(JSON.stringify({...receipt,run_id:bad})+"\n")).toThrow("identifier");
 }
 for (const field of ["instance_id","boot_id"]) for (const bad of ["PRIVATE_SOURCE_SENTINEL", "12345678-1234-0123-8123-123456789abc", execution.instance_id.toUpperCase()]) {
  expect(()=>strictReceiptProjection(JSON.stringify({...receipt,execution:{...execution,[field]:bad}})+"\n")).toThrow("identifier");
 }
});

test("init refuses future or unsupported schedule policy before creating a report", () => {
 for(const update of ["next_run_at='2099-01-01T00:00:00.000Z'", "jitter_s=604800", "period_s=604800"]) {
  const f=fixture();const db=openLedger(join(f.vault,".kizuki/kizuki.db"));
  db.exec(`UPDATE schedules SET ${update}`);db.close();
  expect(()=>initQualification(f.artifact,f.proof,f.scope,f.out)).toThrow("rail profile");
  expect(()=>statSync(f.out)).toThrow();
 }
});
