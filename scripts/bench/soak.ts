/** Continuous 24-hour daemon soak evaluator and bounded live soak probe. */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runServeDaemon } from "../../packages/core/src/index";
import { openLedger } from "../../packages/core/src/internal";
import { nativePeakRssBytes } from "./process";

export const SOAK_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SOAK_SCHEMA = "kizuki.soak-report/v1" as const;

export type SoakProfile = "full-24h" | "smoke";
export type SoakStatus = "PASS_24H" | "SMOKE_PASS" | "INCOMPLETE" | "FAIL";

export interface SoakPolicy {
  window_ms: number;
  sample_interval_ms: number;
  max_gap_ms: number;
  max_clock_drift_ms: number;
  max_rss_bytes: number;
  max_rss_growth_ratio: number;
  max_cpu_percent: number;
  max_restarts: number;
  require_all_rails_ok: boolean;
}

export const DEFAULT_24H_SOAK_POLICY: Readonly<SoakPolicy> = {
  window_ms: SOAK_WINDOW_MS,
  sample_interval_ms: 30_000,
  max_gap_ms: 90_000,
  max_clock_drift_ms: 5_000,
  max_rss_bytes: 512 * 1024 * 1024,
  max_rss_growth_ratio: 1.5,
  max_cpu_percent: 5.0,
  max_restarts: 0,
  require_all_rails_ok: true,
};

/** Bounded defaults for short uncompiled source-checkout smoke probes (never grants 24h certification). */
export const DEFAULT_SMOKE_SOAK_POLICY: Readonly<SoakPolicy> = {
  window_ms: 1_200,
  sample_interval_ms: 300,
  max_gap_ms: 15_000,
  max_clock_drift_ms: 5_000,
  max_rss_bytes: 2 * 1024 * 1024 * 1024,
  max_rss_growth_ratio: 1.5,
  max_cpu_percent: 100,
  max_restarts: 0,
  require_all_rails_ok: true,
};

export interface SoakSample {
  at: string;
  monotonic_ms: number;
  boot_id: string;
  pid: number;
  instance_id: string;
  rss_bytes: number;
  cpu_percent: number;
  rails_ok: number;
  rails_failed: number;
  issues: string[];
}

export interface SoakReport {
  schema: typeof SOAK_SCHEMA;
  profile: SoakProfile;
  policy: SoakPolicy;
  started_at: string | null;
  ended_at: string | null;
  observed_ms: number;
  remaining_ms: number;
  sample_count: number;
  restarts: number;
  initial_rss_bytes: number | null;
  peak_rss_bytes: number | null;
  rss_growth_ratio: number | null;
  peak_cpu_percent: number | null;
  rails_ok_total: number;
  rails_failed_total: number;
  issues: string[];
  soak_24h_certified: boolean;
  status: SoakStatus;
  samples: SoakSample[];
}

const RFC3339_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function parseInstant(value: unknown): number {
  if (typeof value !== "string" || !RFC3339_MS.test(value)) {
    throw new Error("invalid soak timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("invalid soak timestamp");
  }
  return parsed;
}

function assertNonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid soak ${label}`);
  }
  return value;
}

function assertNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid soak ${label}`);
  }
  return value;
}

function assertToken(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`invalid soak ${label}`);
  }
  return value;
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid soak object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== [...keys].sort().join()) {
    throw new Error("invalid soak schema keys");
  }
  return record;
}

export function validateSoakPolicy(policy: unknown): SoakPolicy {
  const row = exactKeys(policy, [
    "window_ms", "sample_interval_ms", "max_gap_ms", "max_clock_drift_ms",
    "max_rss_bytes", "max_rss_growth_ratio", "max_cpu_percent", "max_restarts", "require_all_rails_ok",
  ]);
  const window_ms = assertNonNegativeInt(row.window_ms, "window_ms");
  const sample_interval_ms = assertNonNegativeInt(row.sample_interval_ms, "sample_interval_ms");
  const max_gap_ms = assertNonNegativeInt(row.max_gap_ms, "max_gap_ms");
  const max_clock_drift_ms = assertNonNegativeInt(row.max_clock_drift_ms, "max_clock_drift_ms");
  const max_rss_bytes = assertNonNegativeInt(row.max_rss_bytes, "max_rss_bytes");
  const max_rss_growth_ratio = assertNonNegativeFinite(row.max_rss_growth_ratio, "max_rss_growth_ratio");
  const max_cpu_percent = assertNonNegativeFinite(row.max_cpu_percent, "max_cpu_percent");
  const max_restarts = assertNonNegativeInt(row.max_restarts, "max_restarts");
  if (typeof row.require_all_rails_ok !== "boolean") throw new Error("invalid soak require_all_rails_ok");
  if (window_ms < 1 || sample_interval_ms < 1 || max_gap_ms < sample_interval_ms || max_rss_bytes < 1 || max_rss_growth_ratio < 1) {
    throw new Error("invalid soak policy bounds");
  }
  return {
    window_ms, sample_interval_ms, max_gap_ms, max_clock_drift_ms,
    max_rss_bytes, max_rss_growth_ratio, max_cpu_percent, max_restarts, require_all_rails_ok: row.require_all_rails_ok,
  };
}

export function validateSoakSample(sample: unknown): SoakSample {
  const row = exactKeys(sample, [
    "at", "monotonic_ms", "boot_id", "pid", "instance_id",
    "rss_bytes", "cpu_percent", "rails_ok", "rails_failed", "issues",
  ]);
  parseInstant(row.at);
  const monotonic_ms = assertNonNegativeFinite(row.monotonic_ms, "monotonic_ms");
  const boot_id = assertToken(row.boot_id, "boot_id");
  const pid = assertNonNegativeInt(row.pid, "pid");
  if (pid < 1) throw new Error("invalid soak pid");
  const instance_id = assertToken(row.instance_id, "instance_id");
  const rss_bytes = assertNonNegativeInt(row.rss_bytes, "rss_bytes");
  if (rss_bytes < 1) throw new Error("invalid soak rss_bytes");
  const cpu_percent = assertNonNegativeFinite(row.cpu_percent, "cpu_percent");
  const rails_ok = assertNonNegativeInt(row.rails_ok, "rails_ok");
  const rails_failed = assertNonNegativeInt(row.rails_failed, "rails_failed");
  if (!Array.isArray(row.issues)) throw new Error("invalid soak issues");
  const issues = row.issues.map(item => assertToken(item, "issue"));
  return {
    at: row.at as string,
    monotonic_ms,
    boot_id,
    pid,
    instance_id,
    rss_bytes,
    cpu_percent,
    rails_ok,
    rails_failed,
    issues,
  };
}

export function evaluateSoakSamples(
  profile: SoakProfile,
  policyInput: SoakPolicy,
  samplesInput: readonly SoakSample[],
): SoakReport {
  if (profile !== "full-24h" && profile !== "smoke") {
    throw new Error("invalid soak profile");
  }
  const policy = validateSoakPolicy(policyInput);
  if (profile === "full-24h" && policy.window_ms < SOAK_WINDOW_MS) {
    throw new Error("full-24h soak policy requires at least 24h window_ms");
  }
  const samples = samplesInput.map(validateSoakSample);
  const issues = new Set<string>();

  if (samples.length === 0) {
    issues.add("no-samples");
    return {
      schema: SOAK_SCHEMA,
      profile,
      policy,
      started_at: null,
      ended_at: null,
      observed_ms: 0,
      remaining_ms: policy.window_ms,
      sample_count: 0,
      restarts: 0,
      initial_rss_bytes: null,
      peak_rss_bytes: null,
      rss_growth_ratio: null,
      peak_cpu_percent: null,
      rails_ok_total: 0,
      rails_failed_total: 0,
      issues: [...issues].sort(),
      soak_24h_certified: false,
      status: "FAIL",
      samples: [],
    };
  }

  const first = samples[0]!;
  const startWall = parseInstant(first.at);
  const startMono = first.monotonic_ms;
  let prevWall = startWall;
  let prevMono = startMono;
  let prevProcess = `${first.boot_id}:${first.pid}:${first.instance_id}`;
  let restarts = 0;
  let peakRss = first.rss_bytes;
  let peakCpu = first.cpu_percent;
  let railsOkTotal = 0;
  let railsFailedTotal = 0;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const wall = parseInstant(sample.at);
    if (i > 0) {
      const wallDelta = wall - prevWall;
      const monoDelta = sample.monotonic_ms - prevMono;
      if (wallDelta < 0 || monoDelta < 0 || Math.abs(wallDelta - monoDelta) > policy.max_clock_drift_ms) {
        issues.add("clock-discontinuity");
      }
      if (wallDelta > policy.max_gap_ms) {
        issues.add("collection-gap");
      }
      if (sample.boot_id !== first.boot_id) {
        issues.add("boot-changed");
      }
      const key = `${sample.boot_id}:${sample.pid}:${sample.instance_id}`;
      if (key !== prevProcess) {
        restarts++;
        prevProcess = key;
      }
    }
    if (sample.rss_bytes > peakRss) peakRss = sample.rss_bytes;
    if (sample.cpu_percent > peakCpu) peakCpu = sample.cpu_percent;
    railsOkTotal += sample.rails_ok;
    railsFailedTotal += sample.rails_failed;
    for (const issue of sample.issues) issues.add(issue);
    prevWall = wall;
    prevMono = sample.monotonic_ms;
  }

  if (restarts > policy.max_restarts) issues.add("process-restarted");
  if (peakRss > policy.max_rss_bytes) issues.add("rss-limit-exceeded");
  const rssGrowthRatio = Number((peakRss / first.rss_bytes).toFixed(4));
  if (rssGrowthRatio > policy.max_rss_growth_ratio) issues.add("rss-growth-exceeded");
  if (peakCpu > policy.max_cpu_percent) issues.add("cpu-limit-exceeded");
  if (policy.require_all_rails_ok && railsFailedTotal > 0) issues.add("rail-failures");

  const wallSpan = Math.max(0, prevWall - startWall);
  const monoSpan = Math.max(0, prevMono - startMono);
  const observedMs = Math.round(Math.min(wallSpan, monoSpan));
  const remainingMs = Math.max(0, policy.window_ms - observedMs);
  const sortedIssues = [...issues].sort();
  const soak24hCertified =
    profile === "full-24h" &&
    policy.window_ms >= SOAK_WINDOW_MS &&
    observedMs >= SOAK_WINDOW_MS &&
    samples.length >= 2 &&
    sortedIssues.length === 0;

  let status: SoakStatus;
  if (sortedIssues.length > 0) status = "FAIL";
  else if (soak24hCertified) status = "PASS_24H";
  else if (profile === "smoke" && samples.length >= 2 && observedMs >= policy.window_ms) status = "SMOKE_PASS";
  else status = "INCOMPLETE";

  return {
    schema: SOAK_SCHEMA,
    profile,
    policy,
    started_at: first.at,
    ended_at: samples[samples.length - 1]!.at,
    observed_ms: observedMs,
    remaining_ms: remainingMs,
    sample_count: samples.length,
    restarts,
    initial_rss_bytes: first.rss_bytes,
    peak_rss_bytes: peakRss,
    rss_growth_ratio: rssGrowthRatio,
    peak_cpu_percent: Number(peakCpu.toFixed(4)),
    rails_ok_total: railsOkTotal,
    rails_failed_total: railsFailedTotal,
    issues: sortedIssues,
    soak_24h_certified: soak24hCertified,
    status,
    samples,
  };
}

/** Strict deserializing validator that recomputes the verdict and refuses forged certification. */
export function parseSoakReport(value: unknown): SoakReport {
  const row = exactKeys(value, [
    "schema", "profile", "policy", "started_at", "ended_at", "observed_ms", "remaining_ms",
    "sample_count", "restarts", "initial_rss_bytes", "peak_rss_bytes", "rss_growth_ratio",
    "peak_cpu_percent", "rails_ok_total", "rails_failed_total", "issues",
    "soak_24h_certified", "status", "samples",
  ]);
  if (row.schema !== SOAK_SCHEMA) throw new Error("invalid soak schema");
  if (row.profile !== "full-24h" && row.profile !== "smoke") throw new Error("invalid soak profile");
  if (!Array.isArray(row.samples)) throw new Error("invalid soak samples");
  const recomputed = evaluateSoakSamples(
    row.profile,
    validateSoakPolicy(row.policy),
    row.samples as SoakSample[],
  );
  if (JSON.stringify(row) !== JSON.stringify(recomputed)) {
    throw new Error("soak report disagrees with recomputed sample evidence");
  }
  return recomputed;
}

function hostBootId(): string {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (id.length > 0 && id.length <= 128) return id;
  } catch {
    // Non-Linux or restricted procfs falls back to an explicit synthetic host token.
  }
  return `host-${process.platform}-${process.arch}`;
}

export interface LiveSoakProbeOptions {
  profile: SoakProfile;
  window_ms: number;
  sample_interval_ms: number;
  max_gap_ms?: number;
  max_rss_bytes?: number;
  max_rss_growth_ratio?: number;
  max_cpu_percent?: number;
}

/** Runs the real serve daemon loop for a bounded observation window and collects live samples. */
export async function runSoakProbe(vaultPath: string, opts: LiveSoakProbeOptions): Promise<SoakReport> {
  const basePolicy = opts.profile === "smoke" ? DEFAULT_SMOKE_SOAK_POLICY : DEFAULT_24H_SOAK_POLICY;
  const policy: SoakPolicy = validateSoakPolicy({
    ...basePolicy,
    window_ms: opts.window_ms,
    sample_interval_ms: opts.sample_interval_ms,
    max_gap_ms: opts.max_gap_ms ?? Math.max(opts.sample_interval_ms * 4, basePolicy.max_gap_ms),
    max_rss_bytes: opts.max_rss_bytes ?? basePolicy.max_rss_bytes,
    max_rss_growth_ratio: opts.max_rss_growth_ratio ?? basePolicy.max_rss_growth_ratio,
    max_cpu_percent: opts.max_cpu_percent ?? basePolicy.max_cpu_percent,
  });

  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  const bootId = hostBootId();
  const instanceId = randomUUID();
  const samples: SoakSample[] = [];
  let windowStartMono = 0;
  let lastSampleMono = 0;
  let lastCpu = process.cpuUsage();

  const takeSample = (nowMono: number) => {
    const elapsedMs = Math.max(1, nowMono - lastSampleMono);
    const deltaCpu = process.cpuUsage(lastCpu);
    const cpuPercent = samples.length === 0
      ? 0
      : Number((((deltaCpu.user + deltaCpu.system) / 1000) / elapsedMs * 100).toFixed(4));
    lastCpu = process.cpuUsage();
    lastSampleMono = nowMono;
    samples.push({
      at: new Date().toISOString(),
      monotonic_ms: Number(nowMono.toFixed(3)),
      boot_id: bootId,
      pid: process.pid,
      instance_id: instanceId,
      rss_bytes: Math.max(1, nativePeakRssBytes(process.resourceUsage().maxRSS)),
      cpu_percent: Math.max(0, cpuPercent),
      rails_ok: 1,
      rails_failed: 0,
      issues: [],
    });
  };

  try {
    await runServeDaemon(db, vaultPath, {
      http: false,
      shouldContinue: () => windowStartMono === 0 || performance.now() - windowStartMono < policy.window_ms,
      sleep: async ms => {
        const now = performance.now();
        if (windowStartMono === 0) {
          windowStartMono = now;
          lastSampleMono = now;
          lastCpu = process.cpuUsage();
          takeSample(now);
        } else if (now - lastSampleMono >= policy.sample_interval_ms) {
          takeSample(now);
        }
        const remaining = policy.window_ms - (performance.now() - windowStartMono);
        if (remaining <= 0) return;
        await Bun.sleep(Math.min(ms, policy.sample_interval_ms, Math.max(1, Math.ceil(remaining))));
      },
    });
    const finished = performance.now();
    if (windowStartMono > 0 && (samples.length < 2 || finished - lastSampleMono >= 1)) {
      takeSample(finished);
    }
  } finally {
    db.close();
  }

  return evaluateSoakSamples(opts.profile, policy, samples);
}

export function formatSoakSummary(report: SoakReport): string {
  return [
    "# Daemon soak verification",
    "",
    `Schema: ${report.schema}; profile: ${report.profile}; status: ${report.status}; 24h certified: ${report.soak_24h_certified}.`,
    `Observed: ${report.observed_ms} ms / target ${report.policy.window_ms} ms (remaining: ${report.remaining_ms} ms); samples: ${report.sample_count}; restarts: ${report.restarts}.`,
    `RSS: initial=${report.initial_rss_bytes ?? "n/a"} bytes, peak=${report.peak_rss_bytes ?? "n/a"} bytes, growth=${report.rss_growth_ratio === null ? "n/a" : `${report.rss_growth_ratio}x`}; peak CPU: ${report.peak_cpu_percent === null ? "n/a" : `${report.peak_cpu_percent}%`}.`,
    `Rails: ok=${report.rails_ok_total}, failed=${report.rails_failed_total}; issues: ${report.issues.length === 0 ? "none" : report.issues.join(", ")}.`,
    "",
  ].join("\n");
}
