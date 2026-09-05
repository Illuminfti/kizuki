/** Explicit, one-shot fixture observation. This script never starts a daemon. */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { parseBuildInfo } from "./stranger-proof";
import { evaluateQualification, qualificationDate, type QualificationProfile, type QualificationReceipt, type QualificationSample } from "../packages/core/src/serve/qualification";
import { loadServeConfig } from "../packages/core/src/serve/config";
import { readProducerDiagnostic } from "../packages/core/src/producer/diagnostics";
import { readServeProcessMarker, servePidPath } from "../packages/core/src/serve/daemon";
import { parseRunExecution, canonicalReceiptContent } from "../packages/core/src/serve/receipts";
import { RAIL_IDS, RUN_STATUSES } from "../packages/core/src/serve/types";

// Exact native producer spellings, not arbitrary labels carrying source content.
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function identifier(value: unknown, grammar: RegExp): string {
  if (typeof value !== "string" || !grammar.test(value)) throw new Error("invalid evidence identifier");
  return value;
}

const LIMIT = 64 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid evidence object");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string): Record<string, unknown> {
  const row = object(value);
  if (Object.keys(row).sort().join() !== keys.split(",").sort().join()) throw new Error("invalid evidence schema keys");
  return row;
}
function allowed(value: Record<string, unknown>, keys: string): void {
  const names=new Set(keys.split(","));
  if(Object.keys(value).some(key=>!names.has(key)))throw new Error("unknown receipt fields");
}
function counter(value: unknown): void {
  if(value!==undefined && (typeof value!=="number" || !Number.isFinite(value) || value<0))throw new Error("invalid receipt counter");
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function text(value: unknown): string { if (typeof value !== "string" || !value || value.length > 4096) throw new Error("invalid evidence string"); return value; }
/** Reject symlinks in every user-controlled path component, including parents. */
function pathCheck(path: string, missingLeaf = false): string {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    if (missingLeaf && i === parts.length - 1 && !existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error("symlink evidence path refused");
  }
  return absolute;
}
function read(path: string, limit = LIMIT): Buffer {
  pathCheck(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error("evidence file is unsafe or exceeds byte limit");
    const data = readFileSync(fd);
    if (data.length > limit) throw new Error("evidence exceeds byte limit");
    return data;
  } finally { closeSync(fd); }
}
function syncDir(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function create(path: string, contents: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(path));
}
function anchor() {
  if (process.platform !== "linux") throw new Error("qualification currently requires Linux boot and process anchors");
  return { at: new Date().toISOString(), monotonic_ms: Math.round(Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000), boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
}
interface Identity { source_sha: string; binary_sha256: string; build_sha256: string; proof_sha256: string; target: string; }
function verifyArtifact(artifact: string, proofPath: string): Identity {
  pathCheck(artifact);
  const names = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
  const expected = names.map((name) => `${hash(read(join(artifact, name), 256 * 1024 * 1024))}  ${name}`).join("\n") + "\n";
  if (read(join(artifact, "SHA256SUMS")).toString() !== expected) throw new Error("artifact checksum mismatch");
  const buildBytes = read(join(artifact, "BUILD.json"));
  const build = parseBuildInfo(join(artifact, "BUILD.json"));
  const proofBytes = read(proofPath, 1024 * 1024), proof = object(JSON.parse(proofBytes.toString()));
  const digest = hash(read(join(artifact, "kizuki"), 256 * 1024 * 1024));
  const required = ["help", "init", "import", "query", "query-result", "context", "context-result", "export", "restore-verify", "restore", "restored-query", "restored-query-result", "restored-context", "restored-context-result"].sort();
  if (proof.schema !== "kizuki.artifact-proof/v1" || proof.source_sha !== build.source_sha || proof.target !== build.target || proof.binary_sha256 !== digest || !Array.isArray(proof.failures) || proof.failures.length || !Array.isArray(proof.steps) || proof.steps.map((s: unknown) => text(object(s).id)).sort().join() !== required.join() || proof.steps.some((s: unknown) => object(s).passed !== true || object(s).exit_code !== 0)) throw new Error("proof does not bind a passing exact artifact");
  return { source_sha: build.source_sha, binary_sha256: digest, build_sha256: hash(buildBytes), proof_sha256: hash(proofBytes), target: build.target };
}
interface Manifest { schema: "kizuki.qualification/v1"; qualification_id: string; policy_sha256: string; artifact: string; proof: string; vault: string; identity: Identity; profile: QualificationProfile; }
function policyDigest(profile: QualificationProfile): string {
  const {start_at, boot_id, monotonic_ms, ...policy} = profile;
  return hash(canonical(policy));
}
function manifestIdentity(path: string) {
  const stat = lstatSync(path, {bigint:true});
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error("unsafe manifest identity");
  return {dev:stat.dev.toString(),ino:stat.ino.toString()};
}
function validateManifest(value: unknown): Manifest {
  const m=exact(value,"schema,qualification_id,policy_sha256,artifact,proof,vault,identity,profile");
  if(m.schema!=="kizuki.qualification/v1" || typeof m.qualification_id!=="string" || !/^[0-9a-f-]{36}$/.test(m.qualification_id)) throw new Error("invalid qualification manifest");
  for(const key of ["artifact","proof","vault"])text(m[key]);
  const identity=exact(m.identity,"source_sha,binary_sha256,build_sha256,proof_sha256,target");
  if(typeof identity.source_sha!=="string" || !/^[0-9a-f]{40}$/.test(identity.source_sha))throw new Error("invalid manifest source identity");
  for(const key of ["binary_sha256","build_sha256","proof_sha256"])if(typeof identity[key]!=="string" || !/^[0-9a-f]{64}$/.test(identity[key] as string))throw new Error("invalid manifest digest");
  text(identity.target);
  const profile=exact(m.profile,"scope,start_at,boot_id,monotonic_ms,rails,brief_hour,timezone,supervisor,sampling_interval_ms,max_gap_ms,lateness_ms");
  identifier(profile.boot_id, UUID);
  if(!Array.isArray(profile.rails))throw new Error("invalid manifest rails");
  for(const rail of profile.rails)exact(rail,"rail,period_s,jitter_s,next_run_at");
  const result=m as unknown as Manifest;
  evaluateQualification(result.profile,[]);
  if(result.policy_sha256!==policyDigest(result.profile))throw new Error("manifest policy digest mismatch");
  return result;
}
interface Entry { seq: number; previous: string; sample: QualificationSample; sha256: string; }
function openObservationDb(vault: string): Database {
  const path = pathCheck(join(vault, ".kizuki/kizuki.db"));
  if (!lstatSync(path).isFile()) throw new Error("unsafe observation database");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { if (!lstatSync(path + suffix).isFile()) throw new Error("unsafe database sidecar"); pathCheck(path + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return new Database(path, {readonly:true});
}
function schedules(vault: string) {
  const db = openObservationDb(vault);
  try {
    const rows = db.query("SELECT rail, period_s, jitter_s, enabled, next_run_at FROM schedules ORDER BY rail LIMIT 101").all() as {rail:string;period_s:number;jitter_s:number;enabled:number;next_run_at:string|null}[];
    if (rows.length !== RAIL_IDS.length || rows.some((r) => r.enabled !== 1 || !r.next_run_at) || rows.map((r) => r.rail).sort().join() !== [...RAIL_IDS].sort().join()) throw new Error("all seven initialized enabled rails are required");
    return rows.map((r) => ({ rail: r.rail, period_s: r.period_s, jitter_s: r.jitter_s, next_run_at: r.next_run_at! }));
  } finally { db.close(); }
}
export function initQualification(artifactInput: string, proofInput: string, scopePath: string, outInput: string) {
  const scope = object(JSON.parse(read(scopePath, 16384).toString()));
  if (Object.keys(scope).sort().join() !== "brief_hour,scope,supervisor,timezone,vault" || scope.scope !== "fixture" || scope.timezone !== "UTC" || scope.supervisor !== "none" || !Number.isInteger(scope.brief_hour) || Number(scope.brief_hour) < 0 || Number(scope.brief_hour) > 23) throw new Error("only explicit UTC fixture scope {scope,vault,brief_hour,timezone,supervisor:none} is supported");
  const artifact = pathCheck(artifactInput), proof = pathCheck(proofInput), vault = pathCheck(text(scope.vault));
  if (loadServeConfig(vault).brief_hour !== scope.brief_hour) throw new Error("scope brief_hour does not match configured morning hour");
  const identity = verifyArtifact(artifact, proof), rails = schedules(vault), now = anchor();
  const profile: QualificationProfile = {scope:"fixture", start_at:now.at, monotonic_ms:now.monotonic_ms, boot_id:now.boot_id, rails, brief_hour:Number(scope.brief_hour), timezone:"UTC", supervisor:"none", sampling_interval_ms:30_000, max_gap_ms:60_000, lateness_ms:30_000};
  const manifest: Manifest = { schema: "kizuki.qualification/v1", qualification_id:randomUUID(), policy_sha256:policyDigest(profile), artifact, proof, vault, identity, profile };
  evaluateQualification(manifest.profile, []);
  const out = pathCheck(outInput, true);
  mkdirSync(out, { mode: 0o700 }); syncDir(dirname(out));
  create(join(out, "manifest.json"), JSON.stringify(manifest) + "\n");
  create(join(out,"genesis.json"),canonical({schema:"kizuki.qualification-genesis/v1",qualification_id:manifest.qualification_id,policy_sha256:manifest.policy_sha256,manifest_sha256:hash(canonical(manifest)),manifest_identity:manifestIdentity(join(out,"manifest.json"))})+"\n");
  create(join(out, "samples.jsonl"), "");
  return {...evaluateQualification(manifest.profile, []), qualification_id:manifest.qualification_id,policy_sha256:manifest.policy_sha256};
}
function load(run: string): { manifest: Manifest; entries: Entry[]; last: string } {
  pathCheck(run);
  const manifestPath=join(run,"manifest.json"), beforeIdentity=manifestIdentity(manifestPath);
  const manifestBytes = read(manifestPath, 65536);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString()));
  const genesisBytes=read(join(run,"genesis.json"),4096);
  const genesis=exact(JSON.parse(genesisBytes.toString()),"schema,qualification_id,policy_sha256,manifest_sha256,manifest_identity");
  exact(genesis.manifest_identity,"dev,ino");
  if(genesis.schema!=="kizuki.qualification-genesis/v1" || genesis.qualification_id!==manifest.qualification_id || genesis.policy_sha256!==manifest.policy_sha256 || genesis.manifest_sha256!==hash(canonical(manifest)) || canonical(genesis.manifest_identity)!==canonical(beforeIdentity) || canonical(beforeIdentity)!==canonical(manifestIdentity(manifestPath)))throw new Error("qualification manifest genesis mismatch");
  const bytes = read(join(run, "samples.jsonl")), raw = bytes.toString();
  if (raw && !raw.endsWith("\n")) throw new Error("torn qualification journal");
  const lines = raw ? raw.slice(0, -1).split("\n") : [];
  if (lines.length > 100_000) throw new Error("qualification journal row limit");
  let last = hash(genesisBytes);
  const entries: Entry[] = [];
  for (const line of lines) {
    const entry = JSON.parse(line) as Entry;
    if (Object.keys(entry).sort().join() !== "previous,sample,seq,sha256" || entry.seq !== entries.length || entry.previous !== last || entry.sha256 !== hash(JSON.stringify({seq:entry.seq,previous:entry.previous,sample:entry.sample}))) throw new Error("qualification hash chain mismatch");
    entries.push(entry); last = entry.sha256;
  }
  return {manifest, entries, last};
}
/** The operational reader intentionally tolerates old records; qualification does not. */
export function strictReceiptProjection(raw: string): QualificationReceipt[] {
  if (Buffer.byteLength(raw) > LIMIT || (raw && !raw.endsWith("\n"))) throw new Error("oversized or torn run journal");
  const lines = raw ? raw.slice(0, -1).split("\n") : [];
  if (lines.length > 100_000) throw new Error("run journal row limit");
  return lines.map((line) => {
    const value = object(JSON.parse(line));
    const counters="events_synced,events_stored,events_duplicate,events_self_skipped,claims_extracted,claims_written,claims_deduped,claims_superseded,canon_writes,canon_reverts";
    allowed(value,`run_id,rail,started_at,finished_at,status,stopped,execution,schedule_transition,${counters},claims_rejected,model,retrieval,budget,errors`);
    for(const key of counters.split(","))counter(value[key]);
    if(value.stopped!==undefined && value.stopped!==null && typeof value.stopped!=="string")throw new Error("invalid receipt stop reason");
    if(value.claims_rejected!==undefined)for(const count of Object.values(object(value.claims_rejected)))counter(count);
    if(value.budget!==undefined)for(const entry of Object.values(object(value.budget))){const item=exact(entry,"used,limit");counter(item.used);counter(item.limit);}
    const run_id = identifier(value.run_id, ULID), rail = text(value.rail), started_at = text(value.started_at), finished_at = text(value.finished_at), status = text(value.status);
    qualificationDate(started_at); qualificationDate(finished_at);
    if (!(RAIL_IDS as readonly string[]).includes(rail) || !(RUN_STATUSES as readonly string[]).includes(status)) throw new Error("unknown run rail or status");
    if (value.execution !== undefined) {
      try { exact(value.execution,"instance_id,pid,boot_id,trigger,due_at"); } catch { throw new Error("invalid run execution identity fields"); }
    }
    const execution = parseRunExecution(value.execution);
    if (value.execution !== undefined && !execution) throw new Error("invalid run execution identity");
    if (execution) { identifier(execution.instance_id, UUID); identifier(execution.boot_id, UUID); }
    if (execution?.due_at) qualificationDate(execution.due_at);
    if (!Array.isArray(value.errors) || value.errors.some((e: unknown) => typeof e !== "string")) throw new Error("invalid run errors");
    const model = object(value.model), retrieval = object(value.retrieval);
    allowed(model,"calls,input_tokens,output_tokens,unavailable,wall_ms,model_ref,usage_unknown,diagnostic");
    if(model.diagnostic!==undefined && readProducerDiagnostic(model.diagnostic)===undefined)throw new Error("invalid receipt model diagnostic");
    allowed(retrieval,"upserts,removals,pending_ops,degraded");
    for(const key of ["calls","input_tokens","output_tokens","unavailable","wall_ms"])counter(model[key]);
    for(const key of ["upserts","removals","pending_ops"])counter(retrieval[key]);
    if(model.model_ref!==undefined && model.model_ref!==null && typeof model.model_ref!=="string")throw new Error("invalid receipt model reference");
    if (!Array.isArray(retrieval.degraded) || retrieval.degraded.some((v:unknown)=>typeof v!=="string") || !Number.isSafeInteger(model.unavailable) || Number(model.unavailable) < 0 || (model.usage_unknown !== undefined && typeof model.usage_unknown !== "boolean")) throw new Error("invalid run health");
    const healthy = value.errors.length === 0 && retrieval.degraded.length === 0 && model.unavailable === 0 && model.usage_unknown !== true && model.diagnostic === undefined;
    return {run_id,rail,started_at,finished_at,status,healthy,execution:execution ?? null,sha256:hash(canonicalReceiptContent(value))};
  });
}
function collect(manifest: Manifest, known: Map<string,string>): QualificationSample {
  const now = anchor(), issues: string[] = [];
  const receipts = strictReceiptProjection(read(join(manifest.vault, ".kizuki/run-receipts.jsonl")).toString()).filter((r) => {
    const old = known.get(r.run_id);
    if (old && old !== r.sha256) throw new Error("conflicting run evidence");
    known.set(r.run_id, r.sha256);
    return !old && qualificationDate(r.finished_at) >= qualificationDate(manifest.profile.start_at);
  });
  const current = schedules(manifest.vault);
  if (loadServeConfig(manifest.vault).brief_hour !== manifest.profile.brief_hour) issues.push("schedule-profile-changed");
  if (JSON.stringify(current.map(({next_run_at, ...r}) => r)) !== JSON.stringify(manifest.profile.rails.map(({next_run_at,...r}) => r))) issues.push("schedule-profile-changed");
  let processBinding: QualificationSample["process"] = null;
  const db = openObservationDb(manifest.vault);
  try {
    const lease = db.query("SELECT holder_pid, holder_boot_id, heartbeat_at, ttl_s FROM leases WHERE name = 'writer'").get() as {holder_pid:number;holder_boot_id:string;heartbeat_at:string;ttl_s:number}|null;
    if (!lease) issues.push("lease-absent");
    else if (!Number.isSafeInteger(lease.ttl_s) || lease.ttl_s <= 0 || lease.ttl_s > 30 || !Number.isSafeInteger(lease.holder_pid) || lease.holder_pid <= 0) issues.push("lease-invalid");
    else if (lease.holder_boot_id !== now.boot_id) issues.push("lease-boot-mismatch");
    else {
      let heartbeat: number | null = null;
      try { heartbeat = qualificationDate(lease.heartbeat_at); } catch { issues.push("lease-invalid"); }
      if (heartbeat !== null && heartbeat > qualificationDate(now.at)) issues.push("lease-heartbeat-future");
      else if (heartbeat !== null && qualificationDate(now.at) - heartbeat > lease.ttl_s * 1000) issues.push("lease-stale");
      else if (heartbeat !== null) {
        let processFailure = "process-marker-unavailable";
        try {
          const marker = readServeProcessMarker(manifest.vault);
          if (!marker) issues.push(existsSync(servePidPath(manifest.vault)) ? "process-marker-invalid" : "process-marker-absent");
          else if (marker.pid !== lease.holder_pid || marker.boot_id !== lease.holder_boot_id || !UUID.test(marker.instance_id) || !UUID.test(marker.boot_id)) issues.push("process-marker-identity-mismatch");
          else {
            processFailure = "process-image-unavailable";
            const proc = `/proc/${lease.holder_pid}`;
            const ticks = () => {
              const value = readFileSync(join(proc,"stat"),"utf8").split(") ")[1]?.split(" ")[19];
              if (!value || !/^[0-9]+$/.test(value)) throw new Error("invalid process start identity");
              return value;
            };
            const before = ticks();
            // /proc/PID/exe is the kernel's running image, intentionally followed here.
            const imageFd = openSync(join(proc,"exe"), constants.O_RDONLY);
            let digest: string;
            try {
              const imageStat = fstatSync(imageFd);
              if (!imageStat.isFile() || imageStat.size > 256 * 1024 * 1024) throw new Error("process image exceeds limit");
              digest = hash(readFileSync(imageFd));
            } finally { closeSync(imageFd); }
            const after = readServeProcessMarker(manifest.vault);
            if (before !== ticks()) issues.push("process-start-identity-changed");
            else if (digest !== manifest.identity.binary_sha256) issues.push("process-image-mismatch");
            else if (!after || after.pid !== marker.pid || after.boot_id !== marker.boot_id || after.instance_id !== marker.instance_id) issues.push("process-marker-changed");
            else processBinding = {pid:lease.holder_pid,boot_id:lease.holder_boot_id,start_ticks:before,binary_sha256:digest,instance_id:marker.instance_id};
          }
        } catch { issues.push(processFailure); }
      }
    }
  } finally { db.close(); }
  return {...anchor(), supervisor:"not-observed", process:processBinding, receipts, issues};
}
export function sampleQualification(runInput: string) {
  const run = pathCheck(runInput);
  const lock = join(run,"sample.lock");
  create(lock, JSON.stringify({pid:process.pid,...anchor()}) + "\n");
  try {
    const {manifest,entries,last} = load(run);
    let sample: QualificationSample;
    let rejected = false;
    let failureReason = "artifact-verification-failed";
    try {
      if (JSON.stringify(verifyArtifact(manifest.artifact,manifest.proof)) !== JSON.stringify(manifest.identity)) throw new Error("artifact or proof identity changed");
      failureReason = "collector-unexpected-failure";
      const known = new Map(entries.flatMap((e) => e.sample.receipts.map((r) => [r.run_id,r.sha256] as const)));
      sample = collect(manifest,known);
    } catch {
      rejected = true;
      sample = {...anchor(),supervisor:"not-observed",process:null,receipts:[],issues:["collection-rejected",failureReason]};
    }
    const payload = {seq:entries.length,previous:last,sample};
    const line = JSON.stringify({...payload,sha256:hash(JSON.stringify(payload))}) + "\n";
    const fd = openSync(join(run,"samples.jsonl"),constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try { if (fstatSync(fd).size + Buffer.byteLength(line) > LIMIT) throw new Error("qualification journal byte limit"); writeFileSync(fd,line); fsyncSync(fd); } finally {closeSync(fd);}
    if (rejected) throw new Error("collection rejected; durable interruption recorded");
    return {...evaluateQualification(manifest.profile,[...entries.map((e)=>e.sample),sample]),qualification_id:manifest.qualification_id,policy_sha256:manifest.policy_sha256};
  } finally {unlinkSync(lock);syncDir(run);}
}
export function statusQualification(run: string) {
  const {manifest,entries} = load(run);
  if (JSON.stringify(verifyArtifact(manifest.artifact,manifest.proof)) !== JSON.stringify(manifest.identity)) throw new Error("artifact or proof identity changed");
  const latest = entries.at(-1)?.sample;
  const now = anchor();
  const age = latest ? qualificationDate(now.at) - qualificationDate(latest.at) : null;
  return {...evaluateQualification(manifest.profile,entries.map((e)=>e.sample)), qualification_id:manifest.qualification_id,policy_sha256:manifest.policy_sha256,identity:manifest.identity, samples:entries.length, last_observed_at:latest?.at ?? null, observation_age_ms:age, continuity_current:latest !== undefined && latest.boot_id === now.boot_id && age !== null && age >= 0 && age <= manifest.profile.max_gap_ms};
}
if (import.meta.main) {
  try {
    const [command,...args] = process.argv.slice(2);
    const flags = new Map<string,string>();
    for (let i=0;i<args.length;i+=2) { const key=args[i]!, value=args[i+1]; if (!key.startsWith("--") || !value || value.startsWith("--") || flags.has(key)) throw new Error("invalid qualification arguments"); flags.set(key,value); }
    let result;
    if (command === "init" && [...flags.keys()].sort().join() === "--artifact,--out,--proof,--scope") result=initQualification(flags.get("--artifact")!,flags.get("--proof")!,flags.get("--scope")!,flags.get("--out")!);
    else if ((command === "sample" || command === "status") && [...flags.keys()].join() === "--run") result=command === "sample" ? sampleQualification(flags.get("--run")!) : statusQualification(flags.get("--run")!);
    else throw new Error("usage: qualification.ts init --artifact DIR --proof FILE --scope FILE --out NEWDIR | sample --run DIR | status --run DIR");
    console.log(JSON.stringify(result,null,2));
  } catch (error) { console.error(error instanceof Error ? error.message : "qualification failed"); process.exitCode=1; }
}
