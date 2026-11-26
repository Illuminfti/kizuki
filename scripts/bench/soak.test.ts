import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../packages/core/src/vault/init";
import { openLedger } from "../../packages/core/src/ledger/db";
import { initServe } from "../../packages/core/src/serve/schema";
import {
  DEFAULT_24H_SOAK_POLICY,
  SOAK_WINDOW_MS,
  evaluateSoakSamples,
  formatSoakSummary,
  parseSoakReport,
  runSoakProbe,
  type SoakPolicy,
  type SoakSample,
} from "./soak";

function buildSamples(count: number, stepMs: number, patch?: (i: number, row: SoakSample) => SoakSample): SoakSample[] {
  const start = Date.parse("2026-11-26T00:00:00.000Z");
  const rows: SoakSample[] = [];
  for (let i = 0; i < count; i++) {
    const base: SoakSample = {
      at: new Date(start + i * stepMs).toISOString(),
      monotonic_ms: 10_000 + i * stepMs,
      boot_id: "boot-stable-0001",
      pid: 4242,
      instance_id: "inst-stable-0001",
      rss_bytes: 120 * 1024 * 1024 + i * 1024,
      cpu_percent: 0.4,
      rails_ok: 1,
      rails_failed: 0,
      issues: [],
    };
    rows.push(patch ? patch(i, base) : base);
  }
  return rows;
}

test("continuous healthy 24h observation passes PASS_24H and round-trips parseSoakReport", () => {
  // 24h at 60s steps = 1441 samples (0 .. 86,400,000 ms inclusive)
  const policy: SoakPolicy = { ...DEFAULT_24H_SOAK_POLICY, sample_interval_ms: 60_000, max_gap_ms: 90_000 };
  const samples = buildSamples(1441, 60_000);
  const report = evaluateSoakSamples("full-24h", policy, samples);
  expect(report.status).toBe("PASS_24H");
  expect(report.soak_24h_certified).toBe(true);
  expect(report.observed_ms).toBe(SOAK_WINDOW_MS);
  expect(report.remaining_ms).toBe(0);
  expect(report.restarts).toBe(0);
  expect(report.issues).toEqual([]);
  expect(parseSoakReport(report)).toEqual(report);
  const md = formatSoakSummary(report);
  expect(md).toContain("PASS_24H");
  expect(md).not.toContain("\u2014");
});

test("short window under full-24h stays INCOMPLETE and refuses forged certification", () => {
  const samples = buildSamples(10, 30_000);
  const report = evaluateSoakSamples("full-24h", DEFAULT_24H_SOAK_POLICY, samples);
  expect(report.status).toBe("INCOMPLETE");
  expect(report.soak_24h_certified).toBe(false);
  expect(report.remaining_ms).toBe(SOAK_WINDOW_MS - 9 * 30_000);

  expect(() => parseSoakReport({ ...report, status: "PASS_24H", soak_24h_certified: true })).toThrow("disagrees");
  expect(() => parseSoakReport({ ...report, extra_field: true })).toThrow("invalid soak schema keys");
});

test("soak evaluator fails closed on gaps, clock drift, restarts, RSS leak, CPU spike, and rail failure", () => {
  const empty = evaluateSoakSamples("full-24h", DEFAULT_24H_SOAK_POLICY, []);
  expect(empty.status).toBe("FAIL");
  expect(empty.issues).toContain("no-samples");

  const gap = evaluateSoakSamples("smoke", { ...DEFAULT_24H_SOAK_POLICY, window_ms: 60_000, max_gap_ms: 30_000 },
    buildSamples(3, 45_000));
  expect(gap.status).toBe("FAIL");
  expect(gap.issues).toContain("collection-gap");

  const drift = evaluateSoakSamples("smoke", { ...DEFAULT_24H_SOAK_POLICY, window_ms: 60_000 },
    buildSamples(3, 30_000, (i, row) => i === 2 ? { ...row, monotonic_ms: row.monotonic_ms + 20_000 } : row));
  expect(drift.status).toBe("FAIL");
  expect(drift.issues).toContain("clock-discontinuity");

  const restart = evaluateSoakSamples("smoke", { ...DEFAULT_24H_SOAK_POLICY, window_ms: 60_000 },
    buildSamples(3, 30_000, (i, row) => i === 2 ? { ...row, pid: 9999 } : row));
  expect(restart.status).toBe("FAIL");
  expect(restart.restarts).toBe(1);
  expect(restart.issues).toContain("process-restarted");

  const leak = evaluateSoakSamples("smoke", { ...DEFAULT_24H_SOAK_POLICY, window_ms: 60_000, max_rss_growth_ratio: 1.2 },
    buildSamples(3, 30_000, (i, row) => i === 2 ? { ...row, rss_bytes: Math.round(row.rss_bytes * 1.5) } : row));
  expect(leak.status).toBe("FAIL");
  expect(leak.issues).toContain("rss-growth-exceeded");

  const hotCpu = evaluateSoakSamples("smoke", { ...DEFAULT_24H_SOAK_POLICY, window_ms: 60_000, max_cpu_percent: 5.0 },
    buildSamples(3, 30_000, (i, row) => i === 1 ? { ...row, cpu_percent: 12.5 } : row));
  expect(hotCpu.status).toBe("FAIL");
  expect(hotCpu.issues).toContain("cpu-limit-exceeded");

  const badRail = evaluateSoakSamples("smoke", { ...DEFAULT_24H_SOAK_POLICY, window_ms: 60_000 },
    buildSamples(3, 30_000, (i, row) => i === 1 ? { ...row, rails_failed: 1 } : row));
  expect(badRail.status).toBe("FAIL");
  expect(badRail.issues).toContain("rail-failures");
});

test("live bounded soak probe runs real serve daemon and returns validated SMOKE_PASS without 24h credit", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-soak-probe-test-"));
  try {
    const vault = join(root, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try { initServe(db); } finally { db.close(); }
    const report = await runSoakProbe(vault, {
      profile: "smoke",
      window_ms: 1000,
      sample_interval_ms: 250,
      max_cpu_percent: 100,
      max_rss_bytes: 2 * 1024 * 1024 * 1024,
    });
    expect(report.schema).toBe("kizuki.soak-report/v1");
    expect(report.profile).toBe("smoke");
    expect(report.status).toBe("SMOKE_PASS");
    expect(report.soak_24h_certified).toBe(false);
    expect(report.sample_count).toBeGreaterThanOrEqual(2);
    expect(report.restarts).toBe(0);
    expect(report.observed_ms).toBeGreaterThanOrEqual(1000);
    expect(parseSoakReport(report)).toEqual(report);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
