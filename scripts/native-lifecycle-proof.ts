/** Closed receipt consistency only. Online source/job/package custody supplies authority. */
import { createHash } from "node:crypto";
import { CURRENT_PACKAGE_FILES } from "./release-artifacts";
import { RAIL_IDS } from "../packages/core/src/serve/types";
import { parseSqliteRuntime } from "../packages/core/src/ledger/runtime";

export const LIFECYCLE_BASELINE_SOURCE = "5d4c9870797607e22d25e30bdda37a879aba9d69";
// Independently compiled consumer contract; the producer's registry digest must agree.
export const LIFECYCLE_HISTORY = [
  { id: "ledger15", file: "doctor-ledger15-legacy.sql", sha256: "1d93c78885930f42bb01c579f4a6d272c5998ffd4b11bd4afe95318b90e8a2ed", writer_commit: "5c50bdc8bf14915ffa3c4e1a011ecc8af45d20a9", writer_bun: "1.3.10", ledger: 15 },
  { id: "ledger16", file: "agent-enrollment-ledger16-claim.sql", sha256: "e9eaa16285ccce0b0d88bfbafde44dc32c698ec9e8ec5ac87b6f9f8394860144", writer_commit: "c5a3aa54c366c1f0f8242448732a797663fb65c1", writer_bun: "1.3.10", ledger: 16 },
  { id: "backup16", file: "agent-enrollment-ledger16-backup.json", sha256: "989a4dab3f3f995e4fd0b6583d9e531aa8edb53228f3d6bf4c355fd3dd82e113", writer_commit: "c5a3aa54c366c1f0f8242448732a797663fb65c1", writer_bun: "1.3.10", ledger: 16 },
  { id: "claim-backup16", file: "agent-enrollment-ledger16-claim-backup.json", sha256: "47c1e866da61b3bdf141e20fbea4cfc9edba6ba6393036ecfc6261f422ea4120", writer_commit: "c5a3aa54c366c1f0f8242448732a797663fb65c1", writer_bun: "1.3.10", ledger: 16 },
] as const;
export const LIFECYCLE_STATE_IDS = ["init-no-service", "state-missing", "state-disabled", "state-failed", "state-masked"] as const;
export const LIFECYCLE_RECOVERY_IDS = ["migrate-ledger15", "migrate-ledger16", "migration-failure-preserved", "migration-backup-recovery", "restore-backup16", "restore-claim-backup16"] as const;
export const LIFECYCLE_MODEL_IDS = ["model-absent", "model-configured", "model-unavailable", "model-credential-loss", "model-dependency-offline"] as const;
export const LIFECYCLE_PHASE_IDS = [...LIFECYCLE_STATE_IDS, "cross-binary-upgrade", ...LIFECYCLE_RECOVERY_IDS, ...LIFECYCLE_MODEL_IDS] as const;
export const LIFECYCLE_REGISTRY_SHA256 = createHash("sha256").update(JSON.stringify({ schema: "kizuki.native-lifecycle-fixtures/v1", baseline_source_sha: LIFECYCLE_BASELINE_SOURCE, recovery: LIFECYCLE_HISTORY, phase_ids: LIFECYCLE_PHASE_IDS })).digest("hex");
export const LIFECYCLE_PRODUCER_ENTRYPOINTS = ["scripts/native-service-lifecycle.ts", "scripts/native-baseline-package.ts", "scripts/native-recovery-fixtures.ts", "scripts/native-model-matrix.ts", "scripts/native-model-endpoint.ts"] as const;
export const LIFECYCLE_PRODUCER_DATA = LIFECYCLE_HISTORY.map(row => `packages/core/test/fixtures/${row.file}`);
export interface NativeLifecycleIdentity { source_sha: string; target: string; bun_version: string; package_sha256: Record<string, string>; }
export class NativeLifecycleProofError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
type Row = Record<string, unknown>;
function need(value: unknown, code = "native-lifecycle-inconsistent"): asserts value { if (!value) throw new NativeLifecycleProofError(code); }
function row(value: unknown, keys: string): Row {
  need(value !== null && typeof value === "object" && !Array.isArray(value), "native-lifecycle-shape");
  need(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "native-lifecycle-shape");
  const expected = keys.split(","), actual = Reflect.ownKeys(value);
  need(actual.length === expected.length && expected.every(key => actual.includes(key)), "native-lifecycle-fields");
  const result: Row = Object.create(null);
  for (const key of expected) { const d = Object.getOwnPropertyDescriptor(value, key); need(d && Object.hasOwn(d,"value"), "native-lifecycle-fields"); result[key] = d.value; }
  return result;
}
function list(value: unknown, max: number): unknown[] {
  need(Array.isArray(value) && value.length <= max && Reflect.ownKeys(value).length === value.length + 1, "native-lifecycle-array");
  return Array.from({ length: value.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(value, String(i)); need(d && Object.hasOwn(d,"value"), "native-lifecycle-array"); return d.value; });
}
function str(value: unknown, max = 256): string { need(typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"), "native-lifecycle-text"); return value; }
function num(value: unknown, min = 0, max = 1_000_000): number { need(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max, "native-lifecycle-number"); return Number(value); }
function hash(value: unknown, length = 64): string { const s = str(value); need(new RegExp(`^[a-f0-9]{${length}}$`).test(s), "native-lifecycle-digest"); return s; }
function time(value: unknown): string { const s = str(value, 64); need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s) && Number.isFinite(Date.parse(s)), "native-lifecycle-time"); return s; }
function booleans(r: Row, keys: string) { for (const key of keys.split(",")) need(typeof r[key] === "boolean", "native-lifecycle-boolean"); }
function equal(a: unknown,b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function hashes(value: unknown): Record<string,string> { const r=row(value,CURRENT_PACKAGE_FILES.join(",")); return Object.fromEntries(CURRENT_PACKAGE_FILES.map(k=>[k,hash(r[k])])); }
function unit(value: unknown, platform: string): string { const s=str(value); need(platform === "linux" ? /^kizuki@[a-zA-Z0-9._-]+\.service$/.test(s) : /^dev\.kizuki\.[a-zA-Z0-9._-]+$/.test(s), "native-lifecycle-unit"); return s; }
function instance(value: unknown) { return str(value,128); }
function boundedJson(value: unknown, depth=0): void {
  need(depth<=12,"native-lifecycle-depth");
  if(value===null || typeof value==="boolean") return;
  if(typeof value==="string") {need(value.length<=65536 && !value.includes("\0"));return;}
  if(typeof value==="number") {need(Number.isFinite(value));return;}
  if(Array.isArray(value)) {for(const item of list(value,128))boundedJson(item,depth+1);return;}
  need(value && typeof value==="object"); const keys=Reflect.ownKeys(value);need(keys.length<=64 && keys.every(k=>typeof k==="string"));
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);need(d&&Object.hasOwn(d,"value"));boundedJson(d.value,depth+1);}
}
function state(id: string, value: unknown, platform: string): Row {
  const e=row(value,"mechanism,unit,unit_state,manager_exit,manager_pid,definition_exists,intent,public_supervisor_state,public_enabled,public_detail,public_doctor_ok,observed_failure,process_absent,definition_sha256");
  unit(e.unit,platform); num(e.manager_exit,0,255); str(e.unit_state);str(e.intent);str(e.public_supervisor_state);
  need(typeof e.public_detail==="string" && e.public_detail.length<=512);booleans(e,"definition_exists,public_enabled,public_doctor_ok,process_absent");
  need(e.manager_pid===null && e.process_absent===true,"native-lifecycle-state-process");
  if(e.definition_sha256!==null)hash(e.definition_sha256);if(e.observed_failure!==null)str(e.observed_failure,512);
  if(id==="state-masked" && platform==="darwin") {need(e.mechanism==="not-applicable-launchd" && e.unit_state==="not-applicable");return e;}
  need(e.mechanism===(platform==="linux"?"systemd":"launchd"));
  if(id==="init-no-service") need(e.definition_exists===false && e.intent==="opted-out" && e.public_supervisor_state==="absent" && e.public_enabled===false && e.public_doctor_ok===true);
  else if(id==="state-missing") need(e.definition_exists===false && e.intent==="installed" && e.public_supervisor_state==="absent" && e.public_enabled===false && e.public_doctor_ok===false);
  else if(id==="state-disabled") need(e.definition_exists===true && e.intent==="installed" && e.public_enabled===false && e.public_doctor_ok===false && ["absent","disabled"].includes(String(e.public_supervisor_state)));
  else if(id==="state-failed") need(e.definition_exists===true && e.intent==="installed" && e.observed_failure!==null && e.public_enabled===true && e.public_doctor_ok===false && e.public_supervisor_state==="disabled" && /^failed(?: \(last exit code [1-9][0-9]*\))?$/.test(String(e.public_detail)));
  else need(e.unit_state==="masked" && e.public_supervisor_state==="masked" && e.public_enabled===false && e.public_doctor_ok===false);
  need(id === "state-masked" ? e.definition_sha256===null : e.definition_exists ? e.definition_sha256!==null : e.definition_sha256===null);
  return e;
}
function model(id: string,value: unknown,platform: string): Row {
  const e=row(value,"unit,instance_id,pid,started_at,receipt_run_id,receipt_status,model_calls,model_unavailable,claims_extracted,canon_writes,endpoint_requests,unexpected_requests,credential_present,model_configured,source_event_present,query_preserved,weights_unchanged,config_unchanged,configuration_unavailable,daemon_active,model_ref_sha256,model_claims,model_canon_receipts,model_output_readable,recovery");
  unit(e.unit,platform);instance(e.instance_id);num(e.pid,2,2**31-1);time(e.started_at);instance(e.receipt_run_id);str(e.receipt_status);
  for(const k of ["model_calls","model_unavailable","claims_extracted","canon_writes","endpoint_requests","unexpected_requests","model_claims","model_canon_receipts"])num(e[k],0,10000);
  booleans(e,"credential_present,model_configured,source_event_present,query_preserved,weights_unchanged,config_unchanged,configuration_unavailable,daemon_active,model_output_readable");
  if(e.model_ref_sha256!==null)hash(e.model_ref_sha256);
  need(e.daemon_active && e.source_event_present && e.query_preserved && e.weights_unchanged && e.config_unchanged && e.unexpected_requests===0,"native-lifecycle-model-common");
  if(id==="model-absent" || id==="model-credential-loss") need(e.model_claims===0 && e.model_canon_receipts===0 && e.model_output_readable===false,"native-lifecycle-unconfigured-model-authority");
  if(id==="model-absent") need(!e.model_configured && !e.credential_present && e.model_calls===0 && e.endpoint_requests===0 && e.model_ref_sha256===null && !e.configuration_unavailable);
  else if(id==="model-credential-loss") need(e.model_configured && !e.credential_present && e.configuration_unavailable && e.model_calls===0 && e.endpoint_requests===0 && e.claims_extracted===0 && e.canon_writes===0);
  else {
    need(e.model_configured && e.credential_present && !e.configuration_unavailable && e.model_ref_sha256!==null);
    if(id==="model-configured") need(e.receipt_status==="ok" && e.model_calls===1 && e.model_unavailable===0 && e.endpoint_requests===1 && e.claims_extracted===1 && Number(e.canon_writes)>0 && e.model_claims===1 && Number(e.model_canon_receipts)>0 && e.model_output_readable);
    else need(e.model_calls===1 && e.model_unavailable===1 && e.claims_extracted===0 && e.model_claims===0 && e.model_canon_receipts===0 && !e.model_output_readable && e.endpoint_requests===(id==="model-unavailable"?1:0) && e.receipt_status!=="ok");
  }
  if(id!=="model-dependency-offline") need(e.recovery===null,"native-lifecycle-model-recovery-unexpected");
  else {
    const r=row(e.recovery,"trigger,unit,pid,instance_id,started_at,receipt_run_id,receipt_status,model_calls,model_unavailable,claims_extracted,canon_writes,endpoint_requests,unexpected_requests,model_claims,model_canon_receipts,model_output_readable,source_event_present,query_preserved,daemon_active,config_unchanged,credential_unchanged,endpoint_unchanged,stop_confirmed,receipt_trigger,receipt_due_at,scheduling_override");
    need(r.trigger==="service-restart"&&r.unit===e.unit&&r.stop_confirmed===true&&r.receipt_trigger==="scheduled");
    const due=row(r.scheduling_override,"rail,old,next,reason");need(due.rail==="sync"&&due.reason==="synthetic-due-time-for-recovery");if(due.old!==null)time(due.old);time(due.next);need(r.receipt_due_at===due.next);num(r.pid,2,2**31-1);instance(r.instance_id);instance(r.receipt_run_id);time(r.started_at);
    const dueAge=Date.parse(String(r.started_at))-Date.parse(String(due.next));need(dueAge>0&&dueAge<60000,"native-lifecycle-model-recovery-due-time");
    need(r.instance_id!==e.instance_id&&r.receipt_run_id!==e.receipt_run_id&&Date.parse(String(r.started_at))>=Date.parse(String(e.started_at)),"native-lifecycle-model-recovery-instance");
    need(r.receipt_status==="ok"&&r.model_calls===1&&r.model_unavailable===0&&r.claims_extracted===1&&r.endpoint_requests===1&&r.unexpected_requests===0&&r.model_claims===1);
    num(r.canon_writes,1,10000);num(r.model_canon_receipts,1,10000);
    for(const k of ["model_output_readable","source_event_present","query_preserved","daemon_active","config_unchanged","credential_unchanged","endpoint_unchanged"])need(r[k]===true,"native-lifecycle-model-recovery-failed");
  }
  return e;
}
function snapshot(value: unknown): Row {
  const r=row(value,"schema_version,schema_sha256,rows_sha256,files_sha256,table_count,row_count,events,claims,integrity,foreign_key_errors");
  num(r.schema_version,1,21);hash(r.schema_sha256);hash(r.rows_sha256);hash(r.files_sha256);num(r.table_count,1,256);num(r.row_count,1,10000);num(r.events,0,10000);num(r.claims,0,10000);need(r.integrity==="ok"&&r.foreign_key_errors===0);return r;
}
function recovery(id: string,value: unknown,expected: NativeLifecycleIdentity): Row {
  const e=row(value,"fixture_id,fixture_sha256,writer_commit,writer_bun,candidate_source_sha,helper_source_sha,executable_sha256,commands,snapshots,preservation,recovery_copy_sha256,failure_scope,retained_failed_vaults,failure_code");
  const fixture=LIFECYCLE_HISTORY[id==="migrate-ledger16"?1:id==="restore-backup16"?2:id==="restore-claim-backup16"?3:0]!;
  need(e.fixture_id===fixture.id && e.fixture_sha256===fixture.sha256 && e.writer_commit===fixture.writer_commit && e.writer_bun===fixture.writer_bun,"native-lifecycle-historical-input");
  need(e.candidate_source_sha===expected.source_sha && e.helper_source_sha===expected.source_sha && e.executable_sha256===expected.package_sha256.kizuki,"native-lifecycle-recovery-identity");
  need(e.failure_code===null);if(e.recovery_copy_sha256!==null)hash(e.recovery_copy_sha256);
  const commands=list(e.commands,16).map(v=>row(v,"step,argv,expected_exit,exit_code,signal,duration_ms,stdout_sha256,stderr_sha256,diagnostic"));
  for(const c of commands){str(c.step);const args=list(c.argv,16).map(v=>str(v,4096));need(args[0]==="kizuki");need(c.expected_exit===0||c.expected_exit===1);need(c.exit_code===c.expected_exit&&c.signal===null);num(c.duration_ms,0,30000);hash(c.stdout_sha256);hash(c.stderr_sha256);need(["none","migration_required","migration_rejected"].includes(String(c.diagnostic)));}
  const snapshots=list(e.snapshots,6).map(v=>{const s=row(v,"role,value");return {role:str(s.role),value:snapshot(s.value)};});
  need(new Set(snapshots.map(s=>s.role)).size===snapshots.length);
  const preservation=row(e.preservation,"events,claims,event_sha256,claim_sha256,original_columns_equal,current_claim_consumer,public_query");
  num(preservation.events);num(preservation.claims);hash(preservation.event_sha256);hash(preservation.claim_sha256);need(typeof preservation.original_columns_equal==="boolean");
  const failed=list(e.retained_failed_vaults,2).map(v=>str(v));
  const expectedCommands=id==="migration-failure-preserved"?["initialize","migrate","initialize","migrate"]:id.startsWith("restore-")?["restore-verify","restore","rebuild","query"]:["initialize","doctor-before","migrate","rebuild","query"];
  need(equal(commands.map(c=>c.step),expectedCommands),"native-lifecycle-recovery-command-inventory");
  for(const c of commands) {
    const denied=c.step==="doctor-before" || (id==="migration-failure-preserved"&&c.step==="migrate");
    need(c.exit_code===(denied?1:0) && c.diagnostic===(denied?(c.step==="doctor-before"?"migration_required":"migration_rejected"):"none"));
  }
  if(id==="migration-failure-preserved") {
    need(equal(snapshots.map(s=>s.role),["admission-before","admission-after","late-ddl-before","late-ddl-after"]));
    need(equal(snapshots[0]!.value,snapshots[1]!.value)&&equal(snapshots[2]!.value,snapshots[3]!.value)&&snapshots.every(s=>s.value.schema_version===15),"native-lifecycle-rollback-changed");
    need(equal(failed,["failed-admission","failed-late-ddl"])&&e.failure_scope==="admission-and-late-ddl-transaction-rollback"&&e.recovery_copy_sha256!==null);
  } else {
    need(failed.length===0&&e.failure_scope==="none"&&preservation.original_columns_equal===true&&preservation.public_query==="passed"&&preservation.events===1);
    need(preservation.current_claim_consumer===(Number(preservation.claims)>0?"passed":"not_applicable"));
    const roles=id.startsWith("restore-")?["restored"]:[id==="migration-backup-recovery"?"recovery-preimage":"before","doctor-after","migrated"];
    need(equal(snapshots.map(s=>s.role),roles));const last=snapshots.at(-1)!.value;
    need(last.schema_version===21&&last.events===preservation.events&&last.claims===preservation.claims);
    if(!id.startsWith("restore-")){need(snapshots[0]!.value.schema_version===fixture.ledger&&equal(snapshots[0]!.value,snapshots[1]!.value),"native-lifecycle-read-mutated-legacy");}
    if(id==="migrate-ledger15"||id==="migration-backup-recovery")need(e.recovery_copy_sha256!==null);
  }
  return e;
}
function baseline(value: unknown, expected: NativeLifecycleIdentity): Row {
  const b=row(value,"source_sha,target,bun_version,package_sha256,runtime");
  need(b.source_sha===LIFECYCLE_BASELINE_SOURCE&&b.source_sha!==expected.source_sha&&b.target===expected.target&&b.bun_version===expected.bun_version,"native-lifecycle-baseline-identity");
  const p=hashes(b.package_sha256);need(p.kizuki!==expected.package_sha256.kizuki&&p["kizuki-mcp"]!==expected.package_sha256["kizuki-mcp"],"native-lifecycle-baseline-not-distinct");
  const r=row(b.runtime,"kizuki,kizuki_mcp"), cli=row(r.kizuki,"executable_sha256,runtime,exit_code,doctor_status"), mcp=row(r.kizuki_mcp,"executable_sha256,runtime,exit_code,mcp_is_error");
  need(cli.executable_sha256===p.kizuki&&mcp.executable_sha256===p["kizuki-mcp"]&&(cli.exit_code===0||cli.exit_code===1)&&["ok","error"].includes(String(cli.doctor_status))&&mcp.exit_code===0&&mcp.mcp_is_error===false);
  const c=parseSqliteRuntime(row(cli.runtime,"schema,bun_version,sqlite_version,sqlite_source_id")), m=parseSqliteRuntime(row(mcp.runtime,"schema,bun_version,sqlite_version,sqlite_source_id"));
  need(equal(c,m)&&c.bun_version===expected.bun_version,"native-lifecycle-baseline-runtime");return {...b,package_sha256:p};
}
function upgrade(value: unknown, expected: NativeLifecycleIdentity, prior: Row, platform:string): Row {
  const e=row(value,"baseline_source_sha,candidate_source_sha,baseline_binary_sha256,candidate_binary_sha256,baseline_schema,candidate_schema,baseline_instance_id,candidate_instance_id,baseline_pid,candidate_pid,vault_id,before_event_sha256,after_event_sha256,baseline_stopped,candidate_active,baseline_query_preserved,candidate_query_preserved,backup_verified,backup_manifest_sha256,unit_sha256,unit");
  const p=prior.package_sha256 as Record<string,string>;
  need(e.baseline_source_sha===LIFECYCLE_BASELINE_SOURCE&&e.candidate_source_sha===expected.source_sha&&e.baseline_binary_sha256===p.kizuki&&e.candidate_binary_sha256===expected.package_sha256.kizuki,"native-lifecycle-upgrade-binary-binding");
  need(e.baseline_schema===21&&e.candidate_schema===21);instance(e.baseline_instance_id);instance(e.candidate_instance_id);need(e.baseline_instance_id!==e.candidate_instance_id);
  num(e.baseline_pid,2,2**31-1);num(e.candidate_pid,2,2**31-1);instance(e.vault_id);hash(e.before_event_sha256);hash(e.after_event_sha256);hash(e.backup_manifest_sha256);hash(e.unit_sha256);unit(e.unit,platform);
  for(const key of ["baseline_stopped","candidate_active","baseline_query_preserved","candidate_query_preserved","backup_verified"])need(e[key]===true);
  need(e.before_event_sha256===e.after_event_sha256,"native-lifecycle-upgrade-content");return e;
}
export const LIFECYCLE_ORIGINAL_STEPS = ["native-user-manager-available","default-init-installs-service","default-init-running","public-status-agrees-with-native-manager","installed-rails-healthy","private-unit","repeat-install","repeat-install-replaces-process","crash-restarts-new-instance","public-graceful-stop","uninstall-before-stopped-read","deliberately-stopped","stopped-import","stopped-evidence-readable","replacement-location-install","replacement-executable-running","native-api-failed-activation-rolls-back","rollback-restores-replacement-process","final-uninstall","uninstall-preserves-readable-vault","export-stopped-vault","verify-recovery-export","restore-stopped-vault","recovered-evidence-readable"] as const;
const ORIGINAL_DIAGNOSTICS=["instrumented-default-init-diagnostics","pre-init-absent-unit-diagnostics","instrumented-repeat-install-diagnostics","uninstrumented-repeat-install","launchd-restarts-after-graceful-exit","launchd-graceful-exit","systemd-graceful-exit"];
function originalSteps(value: unknown,platform:string): { steps:Row[];units:string[] } {
  const steps=list(value,128).map(v=>row(v,"id,passed,evidence"));
  const allowed=new Set<string>([...LIFECYCLE_ORIGINAL_STEPS,...ORIGINAL_DIAGNOSTICS]);
  let next=0;const counts=new Map<string,number>();const units:string[]=[];
  for(const s of steps){const id=str(s.id);need(allowed.has(id),"native-lifecycle-step-unknown");need(s.passed===true,"native-lifecycle-step-failed");boundedJson(s.evidence);
    const count=(counts.get(id)??0)+1;counts.set(id,count);need(count<=(platform==="darwin"&&id==="repeat-install-replaces-process"?2:1),"native-lifecycle-step-duplicate");
    if(id===LIFECYCLE_ORIGINAL_STEPS[next])next++;
    if(platform==="linux")need(!id.startsWith("launchd-") && !["instrumented-default-init-diagnostics","instrumented-repeat-install-diagnostics","uninstrumented-repeat-install"].includes(id));
    else need(!["systemd-graceful-exit","pre-init-absent-unit-diagnostics"].includes(id));
    const e=s.evidence as Row;
    if(e&&typeof e==="object"&&Object.hasOwn(e,"exit_code"))need(e.exit_code===0,"native-lifecycle-command-failed");
    const rawCommands=["public-status-agrees-with-native-manager","stopped-evidence-readable","uninstall-preserves-readable-vault","recovered-evidence-readable","systemd-graceful-exit"];
    const cliCommands=["public-graceful-stop","uninstall-before-stopped-read","stopped-import","replacement-location-install","final-uninstall","export-stopped-vault","verify-recovery-export","restore-stopped-vault","uninstrumented-repeat-install"];
    if(rawCommands.includes(id)||cliCommands.includes(id)||id==="repeat-install"||id==="default-init-installs-service"){
      const extra=id==="default-init-installs-service"?",instrumented,timing_changed,native_status":id==="repeat-install"&&platform==="darwin"?",instrumented,timing_changed":cliCommands.includes(id)||id==="repeat-install"?",command":"";
      const command=row(s.evidence,"exit_code,stdout,stderr"+extra);need(command.exit_code===0);
      need(typeof command.stdout==="string"&&typeof command.stderr==="string");
      if(extra.includes("command")){const argv=list(command.command,32);need(argv.length>=2&&argv[0]==="kizuki");argv.forEach(v=>str(v,4096));}
      if(extra.includes("instrumented")){need(typeof command.instrumented==="boolean"&&command.timing_changed===command.instrumented);if(id==="repeat-install")need(command.instrumented===true);}
      if(id==="systemd-graceful-exit")need(/^ExecMainStatus=0$/m.test(command.stdout),"native-lifecycle-native-stop-failed");
      if(["stopped-evidence-readable","uninstall-preserves-readable-vault","recovered-evidence-readable"].includes(id))need(command.stdout.includes("observatory"),"native-lifecycle-query-unreadable");
      if(id==="public-status-agrees-with-native-manager"){
        let status:any;try{status=JSON.parse(command.stdout);}catch{need(false);}
        const original=steps.find(step=>step.id==="default-init-running")!.evidence as Row;
        need(status?.data?.pid===original.manager_pid&&status?.data?.supervisor?.state==="active"&&status?.data?.supervisor?.enabled===true,"native-lifecycle-public-manager-mismatch");
      }
    }
    if(id==="native-user-manager-available"){const e=row(s.evidence,"command,exit_code");need(e.exit_code===0&&e.command===(platform==="darwin"?"launchctl print gui/<uid>":"systemctl --user show --property=Version"));}
    if(id==="launchd-graceful-exit"){const e=row(s.evidence,"operation,exit_code,signal,duration_ms,state,pid,last_exit_code,error,output_truncated");need(e.operation==="print"&&e.exit_code===0&&e.signal===null&&e.last_exit_code===0&&e.output_truncated===false);num(e.duration_ms,0,60000);}
    if(id==="private-unit"){const e=row(s.evidence,"unit,mode,sha256");need(e.mode===384);hash(e.sha256);units.push(unit(e.unit,platform));}
    if(["default-init-running","repeat-install-replaces-process","crash-restarts-new-instance","replacement-executable-running","rollback-restores-replacement-process","launchd-restarts-after-graceful-exit"].includes(id)){
      const e=row(s.evidence,"manager_pid,marker_pid,instance_id,command");num(e.manager_pid,2,2**31-1);need(e.manager_pid===e.marker_pid);instance(e.instance_id);str(e.command,8192);
    }
    if(id==="native-api-failed-activation-rolls-back"){const e=row(s.evidence,"failure,unit_sha256,recovery_journal_exists,boundary");str(e.failure,4096);hash(e.unit_sha256);need(e.recovery_journal_exists===false);str(e.boundary,512);}
    if(id==="deliberately-stopped"){const e=row(s.evidence,"unit_exists,intent");need(e.unit_exists===false&&e.intent==="opted-out");}
    if(id==="installed-rails-healthy"){
      const e=row(s.evidence,"exit_code,doctor_ok,canon_writing,failures,identity_degraded,rails,diagnostics");need(e.exit_code===0&&e.doctor_ok===true&&e.canon_writing==="off"&&list(e.failures,16).length===0);
      const d=row(e.diagnostics,"complete,truncated,error,receipts");need(d.complete===true&&d.truncated===false&&d.error===null);
      const rails=list(e.rails,8).map(v=>row(v,"rail,status,reason"));need(rails.length===RAIL_IDS.length&&RAIL_IDS.every(id=>rails.filter(r=>r.rail===id&&r.status==="ok"&&r.reason===null).length===1));
      list(e.identity_degraded,16).forEach(v=>str(v));
      const reads=list(d.receipts,32).map(v=>row(v,"rail,status,finished_at,current_instance,errors,retrieval_degraded"));
      need(RAIL_IDS.every(id=>reads.some(r=>r.rail===id&&r.current_instance===true)),"native-lifecycle-rail-coverage");for(const r of reads){str(r.rail);time(r.finished_at);need(typeof r.current_instance==="boolean");list(r.errors,16);list(r.retrieval_degraded,16);if(r.current_instance)need(r.status==="ok"&&(r.errors as unknown[]).length===0&&(r.retrieval_degraded as unknown[]).length===0);}
    }
  }
  need(next===LIFECYCLE_ORIGINAL_STEPS.length,"native-lifecycle-step-inventory");
  need(counts.get(platform==="darwin"?"launchd-graceful-exit":"systemd-graceful-exit")===1,"native-lifecycle-platform-stop");
  if(platform==="darwin")need(counts.get("uninstrumented-repeat-install")===1&&counts.get("repeat-install-replaces-process")===2,"native-lifecycle-repeat-uninstrumented");
  return {steps,units};
}
export function validateNativeLifecycle(value: unknown,expected:NativeLifecycleIdentity) {
  const r=row(value,"schema,source_sha,target,host,binary_sha256,package_sha256,steps,failures,scope,qualification,passed,cleanup");
  need(r.schema==="kizuki.native-service-lifecycle/v2","native-lifecycle-schema");
  hash(expected.source_sha,40);need(expected.bun_version==="1.3.14");
  const platform=expected.target==="bun-linux-x64-baseline"?"linux":expected.target==="bun-darwin-arm64"?"darwin":null;need(platform,"native-lifecycle-target");
  need(r.source_sha===expected.source_sha&&r.target===expected.target&&r.binary_sha256===expected.package_sha256.kizuki,"native-lifecycle-identity");
  need(equal(hashes(r.package_sha256),hashes(expected.package_sha256)),"native-lifecycle-package-binding");
  const host=row(r.host,"platform,arch,kernel,bun,uid");need(host.platform===platform&&host.arch===(platform==="linux"?"x64":"arm64")&&host.bun===expected.bun_version);num(host.uid,1,2**31-1);str(host.kernel);
  need(r.passed===true&&list(r.failures,32).length===0,"native-lifecycle-failed");
  const scope=row(r.scope,"native_user_service,synthetic_vault_only,release_upgrade,migration_rollback,configured_model,cross_binary_fixture_upgrade,historical_migration,configured_synthetic_model,dependency_offline_startup,hardware_reboot,host_network_isolation");
  for(const [k,v] of Object.entries(scope))need(v===!["release_upgrade","hardware_reboot","host_network_isolation"].includes(k),"native-lifecycle-scope");
  const original=originalSteps(r.steps,platform), q=row(r.qualification,"registry_sha256,baseline,phases,recovery_services");
  need(q.registry_sha256===LIFECYCLE_REGISTRY_SHA256,"native-lifecycle-registry");
  const prior=baseline(q.baseline,expected), phases=list(q.phases,17).map(v=>row(v,"id,passed,evidence"));
  need(equal(phases.map(p=>p.id),LIFECYCLE_PHASE_IDS)&&phases.every(p=>p.passed===true),"native-lifecycle-phase-inventory");
  const admitted=new Map<string,Row>();const units=new Set(original.units);const instances=new Set<string>();const receipts=new Set<string>();
  for(const phase of phases){const id=String(phase.id);let e:Row;
    if((LIFECYCLE_STATE_IDS as readonly string[]).includes(id))e=state(id,phase.evidence,platform);
    else if(id==="cross-binary-upgrade")e=upgrade(phase.evidence,expected,prior,platform);
    else if((LIFECYCLE_RECOVERY_IDS as readonly string[]).includes(id))e=recovery(id,phase.evidence,expected);
    else {e=model(id,phase.evidence,platform);need(!instances.has(String(e.instance_id))&&!receipts.has(String(e.receipt_run_id)),"native-lifecycle-model-instance-reused");instances.add(String(e.instance_id));receipts.add(String(e.receipt_run_id));}
    admitted.set(id,e);if(e.unit!==undefined&&e.mechanism!=="not-applicable-launchd")units.add(String(e.unit));
  }
  const first=admitted.get("migrate-ledger15")!, failed=admitted.get("migration-failure-preserved")!, recovered=admitted.get("migration-backup-recovery")!;
  need(first.recovery_copy_sha256===failed.recovery_copy_sha256&&first.recovery_copy_sha256===recovered.recovery_copy_sha256,"native-lifecycle-recovery-copy-binding");
  const firstSnapshot=(first.snapshots as Row[])[0]!, recoveredSnapshot=(recovered.snapshots as Row[])[0]!;
  need(equal(firstSnapshot.value,recoveredSnapshot.value),"native-lifecycle-recovery-preimage-binding");
  const services=list(q.recovery_services,5).map(v=>row(v,"id,vault_id,unit,pid,instance_id,ledger_schema,active,stopped,event_text_sha256"));
  need(equal(services.map(s=>s.id),LIFECYCLE_RECOVERY_IDS.filter(id=>id!=="migration-failure-preserved")),"native-lifecycle-recovery-service-inventory");
  const serviceIds=new Set<string>();
  for(const s of services){instance(s.vault_id);instance(s.instance_id);num(s.pid,2,2**31-1);hash(s.event_text_sha256);need(s.ledger_schema===21&&s.active===true&&s.stopped===true);const u=unit(s.unit,platform);need(!serviceIds.has(u));serviceIds.add(u);units.add(u);}
  const cleanup=row(r.cleanup,"attempted,service_gone,unit_removed,synthetic_root_removed,units");
  for(const k of ["attempted","service_gone","unit_removed","synthetic_root_removed"])need(cleanup[k]===true,"native-lifecycle-cleanup-incomplete");
  const removed=list(cleanup.units,32).map(v=>{const c=row(v,"unit,service_gone,unit_removed");need(c.service_gone===true&&c.unit_removed===true,"native-lifecycle-unit-cleanup");return unit(c.unit,platform);});
  need(new Set(removed).size===removed.length&&removed.length===units.size&&[...units].every(u=>removed.includes(u)),"native-lifecycle-cleanup-inventory");
  return {schema:"kizuki.native-lifecycle-validated/v1" as const,status:"PASS" as const,source_sha:expected.source_sha,target:expected.target,registry_sha256:LIFECYCLE_REGISTRY_SHA256,
    phase_ids:[...LIFECYCLE_PHASE_IDS],baseline_source_sha:LIFECYCLE_BASELINE_SOURCE,baseline_evidence:"reviewed-producer-observation-not-downloaded-baseline-bytes" as const,
    scope:"native-installed-candidate-lifecycle" as const,release_upgrade:false,hardware_reboot:false,host_network_isolation:false,
    observed_model_starts:[...LIFECYCLE_MODEL_IDS.map(id=>String(admitted.get(id)!.started_at)),String((admitted.get("model-dependency-offline")!.recovery as Row).started_at)]};
}
