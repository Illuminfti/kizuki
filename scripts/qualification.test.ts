import * as fs from "node:fs";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, symlinkSync, statSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checksumManifest } from "./release-artifacts";
import { initQualification, sampleQualification, statusQualification, strictReceiptProjection } from "./qualification";
import { initVault } from "../packages/core/src/vault/init";
import { openLedger } from "../packages/core/src/ledger/db";
import { initServe } from "../packages/core/src/serve/schema";
import { ARTIFACT_PACKAGE_FILES, artifactProofSteps, SQLITE_ENGINE_POLICY } from "./artifact-proof";
import type { ArtifactProofSchema } from "./artifact-proof";
import type { SqliteRuntime } from "../packages/core/src/ledger/runtime";
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(schema: ArtifactProofSchema = "kizuki.artifact-proof/v1"){
 const root=mkdtempSync(join(tmpdir(),"kizuki-qualification-test-"));dirs.push(root);
 const artifact=join(root,"artifact"),vault=join(root,"vault"),proof=join(root,"proof.json"),scope=join(root,"scope.json"),out=join(root,"report");
 mkdirSync(artifact);initVault(vault);const db=openLedger(join(vault,".kizuki/kizuki.db"));initServe(db);db.query("UPDATE schedules SET next_run_at = ?").run(new Date().toISOString());db.close();
 writeFileSync(join(vault,".kizuki/run-receipts.jsonl"),"");
 for(const name of ["kizuki","kizuki-mcp","README.txt"])writeFileSync(join(artifact,name),`synthetic ${name} artifact fixture: never executed`);
 const bun_version = schema === "kizuki.artifact-proof/v1" ? "1.3.10" : "1.3.14";
 writeFileSync(join(artifact,"BUILD.json"),JSON.stringify({schema:"kizuki.release-build/v1",source_sha:"a".repeat(40),target:"bun-linux-x64-baseline",bun_version}));
 writeFileSync(join(artifact,"SHA256SUMS"),checksumManifest(artifact,["kizuki","kizuki-mcp","README.txt","BUILD.json"]));
 const package_sha256 = Object.fromEntries(ARTIFACT_PACKAGE_FILES.map(name => [name, hash(readFileSync(join(artifact, name)))]));
 const execution = "/tmp/kizuki-qualification-proof-synthetic/execution";
 const paths = { executable: "/tmp/kizuki-qualification-proof-synthetic/artifact/kizuki", home: `${execution}/home`, config: `${execution}/config/kizuki.toml`, vault: `${execution}/vault`, restored_vault: `${execution}/restored` };
 const entry = SQLITE_ENGINE_POLICY.accepted[0];
 const runtime: SqliteRuntime = { schema: "kizuki.sqlite-runtime/v1", bun_version, sqlite_version: entry.sqlite_version, sqlite_source_id: entry.sqlite_source_id };
 const receipt = { schema, source_sha: "a".repeat(40), target: "bun-linux-x64-baseline", host_platform: "linux", host_arch: "x64",
   bun_version, binary_sha256: package_sha256.kizuki!, package_sha256, paths, failures: [] as string[],
   steps: artifactProofSteps(schema, paths).map(step => ({ ...step, passed: true, exit_code: 0 })),
   ...(schema === "kizuki.artifact-proof/v2" ? { host_kernel_release: "synthetic-kernel", engine_observations: {
     kizuki: { executable_sha256: package_sha256.kizuki!, runtime: { ...runtime }, exit_code: 0, doctor_status: "ok" },
     kizuki_mcp: { executable_sha256: package_sha256["kizuki-mcp"]!, runtime: { ...runtime }, exit_code: 0, mcp_is_error: false },
   } } : {}),
 };
 const saveProof = () => writeFileSync(proof, JSON.stringify(receipt)); saveProof();
 writeFileSync(scope,JSON.stringify({scope:"fixture",vault,brief_hour:7,timezone:"UTC",supervisor:"none"}));
 return{root,artifact,vault,proof,scope,out,receipt,saveProof};
}
test("init binds proof/build/checksums, uses private files and refuses overwrite",()=>{
 const f=fixture();expect(initQualification(f.artifact,f.proof,f.scope,f.out).status).toBe("awaiting-observation");
 expect(statSync(f.out).mode & 0o777).toBe(0o700);expect(statSync(join(f.out,"manifest.json")).mode & 0o777).toBe(0o600);
 expect(()=>initQualification(f.artifact,f.proof,f.scope,f.out)).toThrow();
 expect(statusQualification(f.out).identity.source_sha).toBe("a".repeat(40));
});

test("historical v1 proof and qualification journal bytes keep their original identity", () => {
 const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);sampleQualification(f.out);
 const paths=[f.proof,...["manifest.json","genesis.json","samples.jsonl"].map(name=>join(f.out,name))];
 const before=paths.map(path=>readFileSync(path));
 const status=statusQualification(f.out);
 expect(status.identity.proof_sha256).toBe(hash(before[0]!));
 expect(status.release_qualified).toBe(false);
 expect(JSON.parse(before[0]!.toString()).bun_version).toBe("1.3.10");
 expect(paths.map(path=>readFileSync(path))).toEqual(before);
});

test.each([0,1])("complete v2 records preserve doctor exit %d and remain fixture-only", exit => {
 const f=fixture("kizuki.artifact-proof/v2");
 f.receipt.engine_observations!.kizuki.exit_code=f.receipt.steps[2]!.exit_code=exit;
 f.receipt.engine_observations!.kizuki.doctor_status=exit===0?"ok":"error";f.saveProof();
 expect(initQualification(f.artifact,f.proof,f.scope,f.out).status).toBe("awaiting-observation");
 expect(statusQualification(f.out)).toMatchObject({release_qualified:false,rail_qualification:"fixture-only",samples:0});
});

for(const [label,mutate] of [
 ["partial old receipt",(f)=>{writeFileSync(f.proof,JSON.stringify({schema:f.receipt.schema,source_sha:f.receipt.source_sha,steps:f.receipt.steps}));}],
 ["substituted command",(f)=>{f.receipt.steps[2]!.command=["kizuki","--help"];f.saveProof();}],
 ["reordered steps",(f)=>{[f.receipt.steps[2],f.receipt.steps[3]]=[f.receipt.steps[3]!,f.receipt.steps[2]!];f.saveProof();}],
 ["wrong timeout",(f)=>{f.receipt.steps[0]!.timeout_ms=0;f.saveProof();}],
 ["unknown receipt field",(f)=>{Object.assign(f.receipt,{extra:true});f.saveProof();}],
 ["duplicate receipt key",(f)=>{writeFileSync(f.proof,`{"schema":"${f.receipt.schema}",${JSON.stringify(f.receipt).slice(1)}`);}],
] satisfies [string,(f:ReturnType<typeof fixture>)=>unknown][]) test(`qualification refuses ${label} before creating its journal`,()=>{
 const f=fixture();mutate(f);
 expect(()=>initQualification(f.artifact,f.proof,f.scope,f.out)).toThrow();
 expect(fs.existsSync(f.out)).toBe(false);
});

for(const [label,mutate] of [
 ["missing MCP",(f)=>Object.assign(f.receipt.engine_observations!,{kizuki_mcp:null})],
 ["different executable",(f)=>{f.receipt.engine_observations!.kizuki_mcp.executable_sha256=f.receipt.binary_sha256;}],
 ["different Bun",(f)=>{f.receipt.engine_observations!.kizuki.runtime.bun_version="9.9.9";}],
 ["different SQLite",(f)=>{f.receipt.engine_observations!.kizuki_mcp.runtime.sqlite_source_id="synthetic other source";}],
 ["unknown matching SQLite",(f)=>{for(const item of Object.values(f.receipt.engine_observations!))item.runtime.sqlite_source_id="synthetic unknown source";}],
 ["contradictory doctor exit",(f)=>{f.receipt.engine_observations!.kizuki.exit_code=1;}],
] satisfies [string,(f:ReturnType<typeof fixture>)=>unknown][]) test(`v2 qualification refuses ${label}`,()=>{
 const f=fixture("kizuki.artifact-proof/v2");mutate(f);f.saveProof();
 expect(()=>initQualification(f.artifact,f.proof,f.scope,f.out)).toThrow();
 expect(fs.existsSync(f.out)).toBe(false);
});

test("a self-consistent v2 package cannot select another Bun policy",()=>{
 const f=fixture("kizuki.artifact-proof/v2"), path=join(f.artifact,"BUILD.json"),build=JSON.parse(readFileSync(path,"utf8"));
 build.bun_version=f.receipt.bun_version="9.9.9";
 writeFileSync(path,JSON.stringify(build));
 writeFileSync(join(f.artifact,"SHA256SUMS"),checksumManifest(f.artifact,ARTIFACT_PACKAGE_FILES.slice(0,-1)));
 for(const name of ARTIFACT_PACKAGE_FILES)f.receipt.package_sha256[name]=hash(readFileSync(join(f.artifact,name)));
 for(const item of Object.values(f.receipt.engine_observations!))item.runtime.bun_version="9.9.9";
 f.saveProof();
 expect(()=>initQualification(f.artifact,f.proof,f.scope,f.out)).toThrow("unsupported-package-bun-version");
 expect(fs.existsSync(f.out)).toBe(false);
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

test("process collection distinguishes absent, stale, invalid and mismatched leases without credit",()=>{
 for (const [kind, patch] of Object.entries({
  "lease-absent":null, "lease-stale":{heartbeat_at:"2020-01-01T00:00:00.000Z"},
  "lease-boot-mismatch":{holder_boot_id:"12345678-1234-4123-8123-123456789abc"},
  "lease-invalid":{ttl_s:31}, "lease-heartbeat-future":{heartbeat_at:"2099-01-01T00:00:00.000Z"},
  "process-marker-absent":{},
 })) {
  const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);
  if(patch!==null){const db=openLedger(join(f.vault,".kizuki/kizuki.db"));const now=new Date().toISOString();const row={holder_pid:process.pid,holder_boot_id:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),heartbeat_at:now,ttl_s:30,...patch};db.query("INSERT INTO leases VALUES ('writer',?,?,?,?,?)").run(row.holder_pid,row.holder_boot_id,now,row.heartbeat_at,row.ttl_s);db.close();}
  const result=sampleQualification(f.out);expect(result.issues).toContain(kind);expect(result.status).toBe("interrupted");expect(result.credited_ms).toBe(0);expect(result.release_qualified).toBe(false);
 }
});

test("process marker and image failures have distinct content-free diagnostics",async()=>{
 const {servePidPath}=await import("../packages/core/src/serve/daemon");
 for(const kind of ["process-marker-invalid","process-marker-unavailable","process-marker-identity-mismatch","process-image-mismatch","process-image-unavailable"]){
  const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);
  const pid=kind==="process-image-unavailable"?2147483647:process.pid;
  const boot=readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();const now=new Date().toISOString();
  const db=openLedger(join(f.vault,".kizuki/kizuki.db"));db.query("INSERT INTO leases VALUES ('writer',?,?,?,?,30)").run(pid,boot,now,now);db.close();
  writeFileSync(servePidPath(f.vault),kind==="process-marker-invalid"?"PRIVATE_DIAGNOSTIC_SENTINEL":JSON.stringify({pid:kind==="process-marker-identity-mismatch"?pid+1:pid,boot_id:boot,instance_id:"12345678-1234-4123-8123-123456789abc"}));
  if(kind==="process-marker-unavailable"){renameSync(servePidPath(f.vault),join(f.root,"marker"));symlinkSync(join(f.root,"marker"),servePidPath(f.vault));}
  const result=sampleQualification(f.out);expect(result.issues).toContain(kind);expect(result.credited_ms).toBe(0);expect(result.release_qualified).toBe(false);expect(readFileSync(join(f.out,"samples.jsonl"),"utf8")).not.toContain("PRIVATE_DIAGNOSTIC_SENTINEL");
 }
});

test("unexpected collector failures leave a durable content-free reason and zero credit",()=>{
 const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);
 writeFileSync(join(f.vault,".kizuki/run-receipts.jsonl"),"PRIVATE_DIAGNOSTIC_SENTINEL\n");
 expect(()=>sampleQualification(f.out)).toThrow("durable interruption");
 const status=statusQualification(f.out);expect(status.issues).toContain("collector-unexpected-failure");expect(status.issues).toContain("collection-rejected");expect(status.credited_ms).toBe(0);expect(status.release_qualified).toBe(false);expect(readFileSync(join(f.out,"samples.jsonl"),"utf8")).not.toContain("PRIVATE_DIAGNOSTIC_SENTINEL");
});


test("a process start identity changing during collection is diagnosed and never credited",async()=>{
 const {servePidPath}=await import("../packages/core/src/serve/daemon");
 const f=fixture();initQualification(f.artifact,f.proof,f.scope,f.out);
 const boot=readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(), now=new Date().toISOString();
 const db=openLedger(join(f.vault,".kizuki/kizuki.db"));db.query("INSERT INTO leases VALUES ('writer',?,?,?,?,30)").run(process.pid,boot,now,now);db.close();
 writeFileSync(servePidPath(f.vault),JSON.stringify({pid:process.pid,boot_id:boot,instance_id:"12345678-1234-4123-8123-123456789abc"}));
 const original=fs.readFileSync;let reads=0;
 const hook=spyOn(fs,"readFileSync").mockImplementation(((...args:any[])=>{
  const result=(original as any)(...args);
  if(args[0]===`/proc/${process.pid}/stat` && ++reads===2){const parts=String(result).split(") ");const fields=parts[1]!.split(" ");fields[19]=String(BigInt(fields[19]!)+1n);return parts[0]+") "+fields.join(" ");}
  return result;
 }) as typeof fs.readFileSync);
 try {const result=sampleQualification(f.out);expect(result.issues).toContain("process-start-identity-changed");expect(result.credited_ms).toBe(0);expect(result.release_qualified).toBe(false);}
 finally {hook.mockRestore();}
});

test("classified model failures are unhealthy evidence and hostile diagnostic fields are refused", () => {
 const receipt={run_id:"01K00000000000000000000004",rail:"sync",started_at:"2026-09-05T00:00:00.000Z",finished_at:"2026-09-05T00:00:01.000Z",status:"degraded",model:{unavailable:0},retrieval:{degraded:[]},errors:[]};
 const project=(diagnostic:unknown)=>strictReceiptProjection(JSON.stringify({...receipt,model:{...receipt.model,diagnostic}})+"\n")[0]!;
 const failure={stage:"response",rule:"unsupported_metadata"};
 const projected=project(failure);
 expect(projected.healthy).toBe(false);
 expect(projected.sha256).not.toBe(project({stage:"response",rule:"bad_response"}).sha256);
 expect(JSON.stringify(projected)).not.toContain("unsupported_metadata");
 for(const diagnostic of [{stage:"claims",field:"predicate",rule:"bounded_string",shape:"object",claim_index:0,claim_count:1},
   {stage:"transport",rule:"http",http_status:503},{stage:"budget",rule:"max_input_tokens",used:0,requested:9000,limit:8000}]) expect(project(diagnostic).healthy).toBe(false);
 for(const diagnostic of [{...failure,private_text:"SYNTHETIC_PRIVATE_CANARY"},{stage:"response",rule:"SYNTHETIC_PRIVATE_CANARY"},null]) {
   expect(()=>project(diagnostic)).toThrow("invalid receipt model diagnostic");
 }
});

test("model identity digests are strict semantic evidence without copying the model identity", () => {
 const receipt={run_id:"01K00000000000000000000005",rail:"sync",started_at:"2026-09-05T00:00:00.000Z",finished_at:"2026-09-05T00:00:01.000Z",status:"ok",model:{unavailable:0,model_ref:"model:[redacted]"},retrieval:{degraded:[]},errors:[]};
 const project=(model_ref_sha256:unknown)=>strictReceiptProjection(JSON.stringify({...receipt,model:{...receipt.model,model_ref_sha256}})+"\n")[0]!;
 expect(project("a".repeat(64)).sha256).not.toBe(project("b".repeat(64)).sha256);
 expect(JSON.stringify(project("a".repeat(64)))).not.toContain("model_ref_sha256");
 for(const invalid of ["SYNTHETIC_PRIVATE_IDENTITY", "A".repeat(64), "a".repeat(63), null, {}]) expect(()=>project(invalid)).toThrow("invalid receipt model identity");
});
