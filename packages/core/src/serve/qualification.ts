import { RAIL_IDS, type RunExecution } from "./types";

export const QUALIFICATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export interface QualificationRail { rail: string; period_s: number; jitter_s: number; next_run_at: string; }
export interface QualificationProfile {
  scope: "fixture";
  start_at: string;
  boot_id: string;
  monotonic_ms: number;
  rails: QualificationRail[];
  brief_hour: number;
  max_gap_ms: number;
  lateness_ms: number;
}
/** Content-free projection, captured before the operational journal can prune it. */
export interface QualificationReceipt {
  run_id: string; sha256: string; rail: string; started_at: string; finished_at: string;
  status: string; execution: RunExecution | null; healthy: boolean;
}
export interface QualificationProcess { pid: number; boot_id: string; start_ticks: string; binary_sha256: string; instance_id: string; }
export interface QualificationSample {
  at: string; monotonic_ms: number; boot_id: string;
  process: QualificationProcess | null;
  receipts: QualificationReceipt[];
  issues: string[];
}
export function qualificationDate(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw new Error("invalid evidence timestamp");
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error("invalid evidence timestamp");
  return time;
}
function nextBrief(time: number, hour: number): number {
  const next = new Date(time); next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= time) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}
/** Pure evidence evaluator. Its fixture result is deliberately never release acceptance. */
export function evaluateQualification(profile: QualificationProfile, samples: readonly QualificationSample[]) {
  const issues = new Set<string>();
  const start = qualificationDate(profile.start_at);
  if (profile.scope !== "fixture") throw new Error("unsupported observation scope");
  if (!Number.isFinite(profile.monotonic_ms) || profile.monotonic_ms < 0 || !Number.isSafeInteger(profile.max_gap_ms) || profile.max_gap_ms <= 0 || profile.max_gap_ms > 60_000 || profile.lateness_ms !== 30_000 || !Number.isInteger(profile.brief_hour) || profile.brief_hour < 0 || profile.brief_hour > 23) throw new Error("invalid qualification profile");
  if (profile.rails.map((r) => r.rail).sort().join() !== [...RAIL_IDS].sort().join()) issues.add("required-rails-missing");
  const due = new Map<string, number>();
  for (const rail of profile.rails) {
    if (!Number.isSafeInteger(rail.period_s) || rail.period_s <= 0 || !Number.isSafeInteger(rail.jitter_s) || rail.jitter_s < 0) throw new Error("invalid rail profile");
    due.set(rail.rail, qualificationDate(rail.next_run_at));
  }
  const seen = new Map<string, string>();
  const bindings = new Map<string, string>();
  let wall = start, mono = profile.monotonic_ms, elapsed = 0, restarts = 0;
  let previousProcess: string | null = null;
  let automatic = 0, unqualified = 0;
  for (const sample of samples) {
    const now = qualificationDate(sample.at);
    const delta = now - wall, monoDelta = sample.monotonic_ms - mono;
    if (!Number.isFinite(sample.monotonic_ms) || delta < 0 || monoDelta < 0 || Math.abs(delta - monoDelta) > 5000) issues.add("clock-discontinuity");
    if (delta > profile.max_gap_ms) issues.add("collection-gap");
    if (sample.boot_id !== profile.boot_id) issues.add("boot-changed");
    sample.issues.forEach((issue) => issues.add(issue));
    const process = sample.process;
    const processKey = process === null ? null : `${process.boot_id}:${process.pid}:${process.start_ticks}:${process.instance_id}`;
    if (!process || process.boot_id !== sample.boot_id) issues.add("process-unverified");
    if (processKey !== null && previousProcess !== null && processKey !== previousProcess) restarts++;
    if (processKey !== null) previousProcess = processKey;
    const sorted = [...sample.receipts].sort((a, b) => qualificationDate(a.finished_at) - qualificationDate(b.finished_at));
    for (const receipt of sorted) {
      const old = seen.get(receipt.run_id);
      if (old !== undefined) { if (old !== receipt.sha256) issues.add("conflicting-run-id"); continue; }
      seen.set(receipt.run_id, receipt.sha256);
      const began = qualificationDate(receipt.started_at), ended = qualificationDate(receipt.finished_at);
      if (ended < start) continue; // pre-observation history supplies no credit
      if (began < start || ended < began || ended > now || ended < wall - profile.max_gap_ms) { issues.add("receipt-outside-observation"); continue; }
      const execution = receipt.execution;
      if (!execution || execution.trigger !== "scheduled") { unqualified++; continue; }
      if (!process || execution.pid !== process.pid || execution.boot_id !== process.boot_id || execution.instance_id !== process.instance_id) { issues.add("run-process-unbound"); continue; }
      const existing = bindings.get(execution.instance_id);
      if (existing && existing !== processKey) { issues.add("instance-identity-conflict"); continue; }
      bindings.set(execution.instance_id, processKey!);
      const spec = profile.rails.find((r) => r.rail === receipt.rail);
      const expected = due.get(receipt.rail);
      if (!spec || expected === undefined || execution.due_at === null || qualificationDate(execution.due_at) !== expected) { issues.add("due-slot-mismatch"); continue; }
      if (began < expected || ended > expected + profile.lateness_ms + spec.jitter_s * 1000) issues.add("missed-rail-slot");
      if (receipt.status !== "ok" || !receipt.healthy) issues.add("rail-not-ok");
      automatic++;
      due.set(receipt.rail, receipt.rail === "brief" ? nextBrief(ended, profile.brief_hour) : ended + spec.period_s * 1000);
    }
    for (const spec of profile.rails) if (now > due.get(spec.rail)! + profile.lateness_ms + spec.jitter_s * 1000) issues.add("missed-rail-slot");
    elapsed = Math.max(0, Math.min(now - start, sample.monotonic_ms - profile.monotonic_ms));
    wall = now; mono = sample.monotonic_ms;
  }
  const valid = issues.size === 0;
  return {
    schema: "kizuki.qualification-status/v1" as const, scope: profile.scope,
    status: !valid ? "interrupted" : elapsed >= QUALIFICATION_WINDOW_MS ? "fixture-window-complete" : "awaiting-observation",
    observed_ms: elapsed, credited_ms: valid ? elapsed : 0,
    remaining_ms: Math.max(0, QUALIFICATION_WINDOW_MS - (valid ? elapsed : 0)),
    automatic_runs: automatic, unqualified_runs: unqualified, process_restarts: restarts,
    issues: [...issues].sort(), release_qualified: false as const,
    estate: "not-observed" as const, human: "not-observed" as const,
    brief_usefulness: "not-observed" as const,
  };
}
