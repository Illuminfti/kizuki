import { expect, test } from "bun:test";
import { CURRENT_PACKAGE_FILES } from "./release-artifacts";
import { lifecycleFixture } from "./native-lifecycle-proof-fixture";
import { validateNativeLifecycle, type NativeLifecycleIdentity } from "./native-lifecycle-proof";
const expected=(target="bun-linux-x64-baseline"):NativeLifecycleIdentity=>({source_sha:"a".repeat(40),target,bun_version:"1.3.14",package_sha256:Object.fromEntries(CURRENT_PACKAGE_FILES.map((name,i)=>[name,String(i+1).repeat(64)]))});
const phase=(f:any,id:string)=>f.qualification.phases.find((p:any)=>p.id===id).evidence;
test.each(["bun-linux-x64-baseline","bun-darwin-arm64"])("closed %s fixture proves consistency only with honest scope",target=>{
 const e=expected(target),result=validateNativeLifecycle(lifecycleFixture(e),e);
 expect(result.status).toBe("PASS");expect(result.phase_ids).toHaveLength(17);expect(result.observed_model_starts).toHaveLength(6);
 expect(result.release_upgrade).toBe(false);expect(result.hardware_reboot).toBe(false);expect(result.baseline_evidence).toContain("not-downloaded");
});
const mutations: [string,(f:any)=>void][]=[
 ["current binary reports old schema",f=>phase(f,"cross-binary-upgrade").candidate_schema=21],
 ["v1 cannot claim v2",f=>f.schema="kizuki.native-service-lifecycle/v1"],
 ["extra envelope field",f=>f.credit=true],
 ["missing scope",f=>delete f.scope.dependency_offline_startup],
 ["false hardware reboot claim",f=>f.scope.hardware_reboot=true],
 ["wrong source",f=>f.source_sha="b".repeat(40)],
 ["wrong target",f=>f.target="bun-darwin-arm64"],
 ["swapped package",f=>f.package_sha256={...f.package_sha256,kizuki:"f".repeat(64)}],
 ["different fixture registry",f=>f.qualification.registry_sha256="f".repeat(64)],
 ["missing phase",f=>f.qualification.phases.pop()],
 ["duplicate phase",f=>f.qualification.phases[1]=f.qualification.phases[0]],
 ["claimed pass with phase failure",f=>f.qualification.phases[1].passed=false],
 ["current binary reused as baseline",f=>f.qualification.baseline.package_sha256.kizuki=f.package_sha256.kizuki],
 ["baseline current source",f=>f.qualification.baseline.source_sha=f.source_sha],
 ["upgrade wrong prior bytes",f=>phase(f,"cross-binary-upgrade").baseline_binary_sha256="e".repeat(64)],
 ["upgrade lost event",f=>phase(f,"cross-binary-upgrade").after_event_sha256="e".repeat(64)],
 ["upgrade old instance reused",f=>phase(f,"cross-binary-upgrade").candidate_instance_id="prior-instance"],
 ["failed active state",f=>phase(f,"state-failed").manager_pid=99],
 ["failed enabled state omitted",f=>phase(f,"state-failed").public_enabled=false],
 ["missing state falsely healthy",f=>phase(f,"state-missing").public_doctor_ok=true],
 ["historical fixture changed",f=>phase(f,"migrate-ledger15").fixture_sha256="e".repeat(64)],
 ["historical helper stale",f=>phase(f,"migrate-ledger16").helper_source_sha="e".repeat(40)],
 ["migration failure claimed success",f=>phase(f,"migration-failure-preserved").commands[1].exit_code=0],
 ["rollback row mutation",f=>phase(f,"migration-failure-preserved").snapshots[1].value.rows_sha256="e".repeat(64)],
 ["rollback nonDB mutation",f=>phase(f,"migration-failure-preserved").snapshots[1].value.files_sha256="e".repeat(64)],
 ["doctor mutates historical DB",f=>phase(f,"migrate-ledger15").snapshots[1].value.schema_version=21],
 ["recovery copy swapped",f=>phase(f,"migration-backup-recovery").recovery_copy_sha256="e".repeat(64)],
 ["recovery preimage swapped",f=>{for(const s of phase(f,"migration-backup-recovery").snapshots.slice(0,2))s.value.rows_sha256="e".repeat(64);}],
 ["claim consumer omitted",f=>phase(f,"restore-claim-backup16").preservation.current_claim_consumer="not_applicable"],
 ["public query omitted",f=>phase(f,"restore-backup16").preservation.public_query="not_run"],
 ["recovery service omitted",f=>f.qualification.recovery_services.pop()],
 ["model receipt reused",f=>phase(f,"model-unavailable").receipt_run_id=phase(f,"model-configured").receipt_run_id],
 ["absent model forged claim",f=>phase(f,"model-absent").model_claims=1],
 ["absent model forged output",f=>phase(f,"model-absent").model_output_readable=true],
 ["credential loss forged receipt",f=>phase(f,"model-credential-loss").model_canon_receipts=1],
 ["credential loss forged output",f=>phase(f,"model-credential-loss").model_output_readable=true],
 ["configured model no authority",f=>phase(f,"model-configured").model_claims=0],
 ["offline model reached endpoint",f=>phase(f,"model-dependency-offline").endpoint_requests=1],
 ["offline recovery not stopped",f=>phase(f,"model-dependency-offline").recovery.stop_confirmed=false],
 ["offline recovery ad hoc trigger",f=>phase(f,"model-dependency-offline").recovery.receipt_trigger="manual"],
 ["offline recovery unbounded schedule",f=>phase(f,"model-dependency-offline").recovery.scheduling_override.rail="other"],
 ["offline recovery old catchup",f=>{phase(f,"model-dependency-offline").recovery.receipt_due_at=phase(f,"model-dependency-offline").recovery.scheduling_override.next="2000-01-01T00:00:00.000Z";}],
 ["offline recovery wrong due receipt",f=>phase(f,"model-dependency-offline").recovery.receipt_due_at=null],
 ["offline recovery missing",f=>phase(f,"model-dependency-offline").recovery=null],
 ["offline recovery same instance",f=>phase(f,"model-dependency-offline").recovery.instance_id="model-dependency-offline"],
 ["offline recovery output absent",f=>phase(f,"model-dependency-offline").recovery.model_output_readable=false],
 ["offline recovery changed config",f=>phase(f,"model-dependency-offline").recovery.config_unchanged=false],
 ["cleanup unit omitted",f=>f.cleanup.units.pop()],
 ["cleanup fabricated unrelated unit",f=>f.cleanup.units.push({unit:"kizuki@extra.service",service_gone:true,unit_removed:true})],
 ["cleanup live unit",f=>f.cleanup.units[0].service_gone=false],
 ["original step omitted",f=>f.steps.splice(2,1)],
 ["original step unknown",f=>f.steps[0].id="made-up"],
 ["original command evidence absent",f=>f.steps[0].evidence={}],
 ["public manager mismatch",f=>f.steps.find((s:any)=>s.id==="public-status-agrees-with-native-manager").evidence.stdout="{}"],
 ["stopped content unreadable",f=>f.steps.find((s:any)=>s.id==="stopped-evidence-readable").evidence.stdout=""],
 ["native stop exit failure",f=>f.steps.find((s:any)=>s.id==="systemd-graceful-exit").evidence.stdout="ExecMainStatus=1"],
 ["original command failed",f=>f.steps[0].evidence.exit_code=1],
 ["rail omitted",f=>f.steps.find((s:any)=>s.id==="installed-rails-healthy").evidence.rails.pop()],
 ["old instance rail only",f=>f.steps.find((s:any)=>s.id==="installed-rails-healthy").evidence.diagnostics.receipts[0].current_instance=false],
 ["undo rollback journal retained",f=>f.steps.find((s:any)=>s.id==="native-api-failed-activation-rolls-back").evidence.recovery_journal_exists=true],
];
test.each(mutations)("refuses forged receipt: %s",(_name,mutate)=>{const e=expected(),f=lifecycleFixture(e);mutate(f);expect(()=>validateNativeLifecycle(f,e)).toThrow();});
test("refuses array holes, accessors, inherited fields and additional snapshot keys",()=>{
 for(const change of [(f:any)=>delete f.qualification.phases[0],(f:any)=>Object.defineProperty(f,"passed",{get(){return true}}),(f:any)=>Object.setPrototypeOf(f,{extra:true}),(f:any)=>phase(f,"migrate-ledger15").snapshots[0].value.extra=true]){
  const e=expected(),f=lifecycleFixture(e);change(f);expect(()=>validateNativeLifecycle(f,e)).toThrow();
 }
});

test("new recovery vault retains its own files while the copied database preimage stays identical",()=>{
 const e=expected(),f=lifecycleFixture(e),recovery=phase(f,"migration-backup-recovery");
 for(const s of recovery.snapshots)s.value.files_sha256="e".repeat(64);
 expect(()=>validateNativeLifecycle(f,e)).not.toThrow();
 recovery.snapshots[1].value.files_sha256="f".repeat(64);
 expect(()=>validateNativeLifecycle(f,e)).toThrow("native-lifecycle-read-mutated-legacy");
});
test("cannot declare historical claim preservation with zero surviving claims",()=>{
 const e=expected(),f=lifecycleFixture(e),r=phase(f,"restore-claim-backup16");
 r.preservation.claims=0;r.preservation.current_claim_consumer="not_applicable";r.snapshots[0].value.claims=0;
 expect(()=>validateNativeLifecycle(f,e)).toThrow("native-lifecycle-historical-claims-lost");
});
test("crash/replacement evidence needs a new instance even if passed is asserted",()=>{
 const e=expected(),f=lifecycleFixture(e);
 f.steps.find((s:any)=>s.id==="crash-restarts-new-instance").evidence.instance_id="repeat-install-replaces-process";
 expect(()=>validateNativeLifecycle(f,e)).toThrow("native-lifecycle-process-not-replaced");
});

for (const target of ["bun-linux-x64-baseline","bun-darwin-arm64"]) {
 test(`recovered service event and vault identity join the original ${target} evidence`,()=>{
  const e=expected(target);
  for(const mutate of [(f:any)=>f.qualification.recovery_services[0].event_text_sha256="e".repeat(64),
   (f:any)=>f.qualification.recovery_services[0].vault_id="foreign-vault",
   (f:any)=>phase(f,"cross-binary-upgrade").vault_id="foreign-vault",
   (f:any)=>phase(f,"migration-failure-preserved").preservation.event_text_sha256="e".repeat(64)]) {
   const f=lifecycleFixture(e);mutate(f);expect(()=>validateNativeLifecycle(f,e)).toThrow();
  }
 });
 test(`offline recovery cannot reuse another ${target} model instance or receipt`,()=>{
  const e=expected(target);
  for(const key of ["instance_id","receipt_run_id"]){const f=lifecycleFixture(e);phase(f,"model-dependency-offline").recovery[key]=phase(f,"model-configured")[key];expect(()=>validateNativeLifecycle(f,e)).toThrow("native-lifecycle-model-instance-reused");}
 });
}

test("service joins use event text bytes rather than the encoded legacy row digest",()=>{
 const e=expected(),f=lifecycleFixture(e),preserved=phase(f,"migrate-ledger15").preservation;
 expect(preserved.event_text_sha256).not.toBe(preserved.event_sha256);expect(()=>validateNativeLifecycle(f,e)).not.toThrow();
 f.qualification.recovery_services[0].event_text_sha256=preserved.event_sha256;
 expect(()=>validateNativeLifecycle(f,e)).toThrow("native-lifecycle-recovery-event-binding");
});

const startupCaptureSteps = () => {
 const evidence = { changed_native_configuration: true, timing_changed: true, release_eligible: false };
 const emptyStream = () => ({ text: "", bytes_read: 0, file_size: 0, truncated: false,
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
 return [
  { id: "mac-startup-capture-enabled", passed: false, evidence: { ...evidence } },
  { id: "mac-startup-output-diagnostics", passed: false, evidence: { ...evidence, limit_bytes_per_stream: 8192,
   output: { stdout: emptyStream(), stderr: emptyStream(), metadata: emptyStream() } } },
 ];
};

test("opt-in Mac startup capture remains diagnostic with every normal phase complete",()=>{
 const e=expected("bun-darwin-arm64"),f=lifecycleFixture(e);
 expect(validateNativeLifecycle(f,e).status).toBe("PASS");
 f.steps.push(...startupCaptureSteps());
 f.failures.push("diagnostic startup capture is ineligible for lifecycle qualification");
 f.passed=false;
 expect(()=>validateNativeLifecycle(f,e)).toThrow("native-lifecycle-failed");
});

for (const index of [0,1]) test(`${startupCaptureSteps()[index]!.id} cannot gain credit through forged passed flags`,()=>{
 const e=expected("bun-darwin-arm64"),f=lifecycleFixture(e);
 const step=startupCaptureSteps()[index]!;
 step.passed=true;
 step.evidence.release_eligible=true;
 f.steps.push(step);
 expect(f.passed).toBe(true);
 expect(f.failures).toEqual([]);
 expect(f.qualification.phases.every((p:any)=>p.passed)).toBe(true);
 expect(()=>validateNativeLifecycle(f,e)).toThrow("native-lifecycle-step-unknown");
});

test("Mac startup capture failure cannot be relabeled as a passing diagnostic",()=>{
 const e=expected("bun-darwin-arm64"),f=lifecycleFixture(e);
 f.steps.push({id:"mac-startup-output-diagnostics",passed:true,evidence:{status:"capture_unavailable"}});
 expect(()=>validateNativeLifecycle(f,e)).toThrow("native-lifecycle-step-unknown");
});
