import { nextScheduleSlot } from "../../src/serve/receipts";
import { expect, test } from "bun:test";
import { evaluateQualification, type QualificationProfile, type QualificationSample } from "../../src/serve/qualification";
const start = Date.parse("2026-09-05T00:00:00.000Z");
const profile: QualificationProfile = { scope: "fixture", start_at: new Date(start).toISOString(), boot_id: "boot", monotonic_ms: 100, rails: [], brief_hour: 7, timezone:"UTC", supervisor:"none", sampling_interval_ms:30_000, max_gap_ms: 60_000, lateness_ms: 30_000 };
function sample(ms: number): QualificationSample { return { at: new Date(start + ms).toISOString(), monotonic_ms: 100 + ms, boot_id: "boot", receipts: [], supervisor:"not-observed", process: null, issues: [] }; }
test("empty/fixture observations never qualify an estate or human gate", () => {
  const result = evaluateQualification(profile, [sample(0)]);
  expect(result.release_qualified).toBe(false);
  expect(result.estate).toBe("not-observed");
  expect(result.human).toBe("not-observed");
  expect(result.status).toBe("interrupted"); // all seven rails are mandatory
});
test("a wall clock jump cannot supply elapsed days", () => {
  const jumped = sample(604_800_000); jumped.monotonic_ms = 101;
  expect(evaluateQualification(profile, [sample(0), jumped]).issues).toContain("clock-discontinuity");
});
test("collector restart retains boot-wide monotonic continuity; reboot interrupts", () => {
  expect(evaluateQualification(profile, [sample(0), sample(1000)]).issues).not.toContain("clock-discontinuity");
  const reboot = sample(1000); reboot.boot_id = "other";
  expect(evaluateQualification(profile, [sample(0), reboot]).issues).toContain("boot-changed");
});
test("uncaptured intervals and backward time interrupt", () => {
  expect(evaluateQualification(profile, [sample(0), sample(61_000)]).issues).toContain("collection-gap");
  expect(evaluateQualification(profile, [sample(1000), sample(0)]).issues).toContain("clock-discontinuity");
});
import { RAIL_IDS } from "../../src/serve/types";
function trace(duration: number) {
  const p: QualificationProfile = {...profile, rails:RAIL_IDS.map(rail=>({rail,period_s:60,jitter_s:0,next_run_at:new Date(start).toISOString()}))};
  const due = new Map<string,number>(RAIL_IDS.map(rail=>[rail,0]));
  const samples: QualificationSample[] = [];
  for(let ms=0;ms<=duration;ms+=60_000) {
    const s=sample(ms); s.process={pid:12,boot_id:"boot",start_ticks:"1",binary_sha256:"a".repeat(64),instance_id:"instance"};
    for(const rail of RAIL_IDS) if(ms===due.get(rail)) {
      s.receipts.push({run_id:`${rail}-${ms}`,sha256:"b".repeat(64),rail,started_at:s.at,finished_at:s.at,status:"ok",healthy:true,execution:{instance_id:"instance",pid:12,boot_id:"boot",trigger:"scheduled",due_at:s.at}});
      if(rail==="brief") {const next=new Date(start+ms);next.setUTCHours(7,0,0,0);if(next.getTime()<=start+ms)next.setUTCDate(next.getUTCDate()+1);due.set(rail,next.getTime()-start);} else due.set(rail,ms+60_000);
    }
    samples.push(s);
  }
  return {p,samples};
}
test("exact seven-day boundary needs every due slot and still proves only fixture observation",()=>{
  const {p,samples}=trace(604_800_000);
  const before = sample(604_799_999); before.process = samples[0]!.process;
  const boundary = evaluateQualification(p,[...samples.slice(0,-1),before]);
  expect(boundary.status).toBe("awaiting-observation"); expect(boundary.remaining_ms).toBe(1);
  const full=evaluateQualification(p,samples);
  expect(full.status).toBe("fixture-window-complete");expect(full.credited_ms).toBe(604_800_000);
  expect(full.release_qualified).toBe(false);expect(full.human).toBe("not-observed");
});
test("manual, once, legacy and degraded receipts cannot fill automatic due slots",()=>{
  for(const mode of ["manual","once","legacy","degraded"]){
    const {p,samples}=trace(60_000); const first=samples[0]!.receipts[0]!;
    if(mode==="legacy") first.execution=null;
    else if(mode==="degraded")first.status="degraded";
    else first.execution={...first.execution!,trigger:mode as "manual"|"once"};
    expect(evaluateQualification(p,samples).status).toBe("interrupted");
  }
});
test("duplicate hashes dedupe, conflicting run ids and unbound processes interrupt",()=>{
  const {p,samples}=trace(0); const first=samples[0]!.receipts[0]!;
  samples[0]!.receipts.push({...first});expect(evaluateQualification(p,samples).automatic_runs).toBe(7);
  samples[0]!.receipts.push({...first,sha256:"c".repeat(64)});expect(evaluateQualification(p,samples).issues).toContain("conflicting-run-id");
  first.execution={...first.execution!,pid:99};expect(evaluateQualification(p,samples).issues).toContain("run-process-unbound");
});

test("repeated maximum lateness cannot shift the frozen seven-day due grid", () => {
  const { p, samples } = trace(604_800_000);
  // Reproduce the old completion-relative scheduler: six rails run every 90s,
  // claiming a new slot after their previous 30s-late completion.
  const drifted = samples.map(s => ({ ...s, receipts: s.receipts.filter(r => r.rail === "brief") }));
  for (let due = 0; due + 30_000 <= 604_800_000; due += 90_000) {
    const ended = due + 30_000;
    const bucket = drifted[Math.ceil(ended / 60_000)]!;
    for (const rail of RAIL_IDS.filter(r => r !== "brief")) bucket.receipts.push({
      run_id: `${rail}-drift-${due}`, sha256: "d".repeat(64), rail,
      started_at: new Date(start + due).toISOString(), finished_at: new Date(start + ended).toISOString(), status: "ok", healthy: true,
      execution: { instance_id: "instance", pid: 12, boot_id: "boot", trigger: "scheduled", due_at: new Date(start + due).toISOString() },
    });
  }
  const result = evaluateQualification(p, drifted);
  expect(result.status).toBe("interrupted");
  expect(result.issues).toContain("due-slot-mismatch");
  expect(result.credited_ms).toBe(0);
});


test("UTC fixture timing does not claim local morning or supervisor qualification across DST", () => {
 const {p,samples}=trace(0);
 for(const day of ["2026-03-08T07:00:00.000Z","2026-11-01T07:00:00.000Z"]){
  expect(nextScheduleSlot(day,86400,7)).toBe(new Date(Date.parse(day)+86_400_000).toISOString());
 }
 const result=evaluateQualification(p,samples);
 expect(result.owner_morning).toBe("unqualified");expect(result.supervised_pilot).toBe("unqualified");
 for(const state of ["masked","disabled"] as const){samples[0]!.supervisor=state;expect(evaluateQualification(p,samples).issues).toContain("supervisor-policy-unqualified");}
});
