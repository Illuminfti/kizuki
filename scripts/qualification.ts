/** Explicit, one-shot fixture observation. This script never starts a daemon. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { parseBuildInfo } from "./stranger-proof";
import { evaluateQualification, qualificationDate, type QualificationProfile, type QualificationReceipt, type QualificationSample } from "../packages/core/src/serve/qualification";
import { loadServeConfig } from "../packages/core/src/serve/config";
import { readServeProcessMarker } from "../packages/core/src/serve/daemon";
import { parseRunExecution } from "../packages/core/src/serve/receipts";
import { RAIL_IDS, RUN_STATUSES } from "../packages/core/src/serve/types";

const LIMIT = 64 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid evidence object");
  return value as Record<string, unknown>;
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
    if (!stat.isFile() || stat.size > limit) throw new Error("evidence file is unsafe or exceeds byte limit");
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
interface Manifest { schema: "kizuki.qualification/v1"; artifact: string; proof: string; vault: string; identity: Identity; profile: QualificationProfile; }
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
  if (Object.keys(scope).sort().join() !== "brief_hour,scope,vault" || scope.scope !== "fixture" || !Number.isInteger(scope.brief_hour) || Number(scope.brief_hour) < 0 || Number(scope.brief_hour) > 23) throw new Error("only explicit fixture scope {scope,vault,brief_hour} is supported");
  const artifact = pathCheck(artifactInput), proof = pathCheck(proofInput), vault = pathCheck(text(scope.vault));
  if (loadServeConfig(vault).brief_hour !== scope.brief_hour) throw new Error("scope brief_hour does not match configured morning hour");
  const identity = verifyArtifact(artifact, proof), rails = schedules(vault), now = anchor();
  const manifest: Manifest = { schema: "kizuki.qualification/v1", artifact, proof, vault, identity, profile: {scope:"fixture", start_at:now.at, monotonic_ms:now.monotonic_ms, boot_id:now.boot_id, rails, brief_hour:Number(scope.brief_hour), max_gap_ms:60_000, lateness_ms:30_000} };
  evaluateQualification(manifest.profile, []);
  const out = pathCheck(outInput, true);
  mkdirSync(out, { mode: 0o700 }); syncDir(dirname(out));
  create(join(out, "manifest.json"), JSON.stringify(manifest) + "\n");
  create(join(out, "samples.jsonl"), "");
  return evaluateQualification(manifest.profile, []);
}
function load(run: string): { manifest: Manifest; entries: Entry[]; last: string } {
  pathCheck(run);
  const manifestBytes = read(join(run, "manifest.json"), 65536);
  const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
  if (manifest.schema !== "kizuki.qualification/v1") throw new Error("invalid qualification manifest");
  evaluateQualification(manifest.profile, []);
  const bytes = read(join(run, "samples.jsonl")), raw = bytes.toString();
  if (raw && !raw.endsWith("\n")) throw new Error("torn qualification journal");
  const lines = raw ? raw.slice(0, -1).split("\n") : [];
  if (lines.length > 100_000) throw new Error("qualification journal row limit");
  let last = hash(manifestBytes);
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
    const run_id = text(value.run_id), rail = text(value.rail), started_at = text(value.started_at), finished_at = text(value.finished_at), status = text(value.status);
    qualificationDate(started_at); qualificationDate(finished_at);
    if (!(RAIL_IDS as readonly string[]).includes(rail) || !(RUN_STATUSES as readonly string[]).includes(status)) throw new Error("unknown run rail or status");
    const execution = parseRunExecution(value.execution);
    if (value.execution !== undefined && !execution) throw new Error("invalid run execution identity");
    if (execution?.due_at) qualificationDate(execution.due_at);
    if (!Array.isArray(value.errors) || value.errors.some((e: unknown) => typeof e !== "string")) throw new Error("invalid run errors");
    const model = object(value.model), retrieval = object(value.retrieval);
    if (!Array.isArray(retrieval.degraded) || !Number.isSafeInteger(model.unavailable) || Number(model.unavailable) < 0 || (model.usage_unknown !== undefined && typeof model.usage_unknown !== "boolean")) throw new Error("invalid run health");
    const healthy = value.errors.length === 0 && retrieval.degraded.length === 0 && model.unavailable === 0 && model.usage_unknown !== true;
    return {run_id,rail,started_at,finished_at,status,healthy,execution:execution ?? null,sha256:hash(line)};
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
    if (lease && Number.isSafeInteger(lease.ttl_s) && lease.ttl_s > 0 && lease.ttl_s <= 30 && Number.isSafeInteger(lease.holder_pid) && lease.holder_pid > 0 && lease.holder_boot_id === now.boot_id && qualificationDate(lease.heartbeat_at) <= qualificationDate(now.at) && qualificationDate(now.at) - qualificationDate(lease.heartbeat_at) <= lease.ttl_s * 1000) {
      try {
        const proc = `/proc/${lease.holder_pid}`;
        const ticks = () => readFileSync(join(proc,"stat"),"utf8").split(") ")[1]!.split(" ")[19]!;
        const before = ticks();
        const marker = readServeProcessMarker(manifest.vault);
        // /proc/PID/exe is the kernel's running image, intentionally followed here.
        const imageFd = openSync(join(proc,"exe"), constants.O_RDONLY);
        let digest: string;
        try {
          const imageStat = fstatSync(imageFd);
          if (!imageStat.isFile() || imageStat.size > 256 * 1024 * 1024) throw new Error("process image exceeds limit");
          digest = hash(readFileSync(imageFd));
        } finally { closeSync(imageFd); }
        if (before === ticks() && digest === manifest.identity.binary_sha256 && marker?.pid === lease.holder_pid && marker.boot_id === lease.holder_boot_id && marker.instance_id === readServeProcessMarker(manifest.vault)?.instance_id) processBinding = {pid:lease.holder_pid,boot_id:lease.holder_boot_id,start_ticks:before,binary_sha256:digest,instance_id:marker.instance_id};
      } catch { issues.push("process-image-unavailable"); }
    }
  } finally { db.close(); }
  return {...anchor(), process:processBinding, receipts, issues};
}
export function sampleQualification(runInput: string) {
  const run = pathCheck(runInput);
  const lock = join(run,"sample.lock");
  create(lock, JSON.stringify({pid:process.pid,...anchor()}) + "\n");
  try {
    const {manifest,entries,last} = load(run);
    let sample: QualificationSample;
    let rejected = false;
    try {
      if (JSON.stringify(verifyArtifact(manifest.artifact,manifest.proof)) !== JSON.stringify(manifest.identity)) throw new Error("artifact or proof identity changed");
      const known = new Map(entries.flatMap((e) => e.sample.receipts.map((r) => [r.run_id,r.sha256] as const)));
      sample = collect(manifest,known);
    } catch {
      rejected = true;
      sample = {...anchor(),process:null,receipts:[],issues:["collection-rejected"]};
    }
    const payload = {seq:entries.length,previous:last,sample};
    const line = JSON.stringify({...payload,sha256:hash(JSON.stringify(payload))}) + "\n";
    const fd = openSync(join(run,"samples.jsonl"),constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try { if (fstatSync(fd).size + Buffer.byteLength(line) > LIMIT) throw new Error("qualification journal byte limit"); writeFileSync(fd,line); fsyncSync(fd); } finally {closeSync(fd);}
    if (rejected) throw new Error("collection rejected; durable interruption recorded");
    return evaluateQualification(manifest.profile,[...entries.map((e)=>e.sample),sample]);
  } finally {unlinkSync(lock);syncDir(run);}
}
export function statusQualification(run: string) {
  const {manifest,entries} = load(run);
  if (JSON.stringify(verifyArtifact(manifest.artifact,manifest.proof)) !== JSON.stringify(manifest.identity)) throw new Error("artifact or proof identity changed");
  const latest = entries.at(-1)?.sample;
  const now = anchor();
  const age = latest ? qualificationDate(now.at) - qualificationDate(latest.at) : null;
  return {...evaluateQualification(manifest.profile,entries.map((e)=>e.sample)), identity:manifest.identity, samples:entries.length, last_observed_at:latest?.at ?? null, observation_age_ms:age, continuity_current:latest !== undefined && latest.boot_id === now.boot_id && age !== null && age >= 0 && age <= manifest.profile.max_gap_ms};
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
