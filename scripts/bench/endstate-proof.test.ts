import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENDSTATE_PROOF_SCHEMA,
  GOLDEN_1065_STAGES,
  evaluateEndStateProof,
  formatEndStateSummary,
  inspectEndStateFiles,
} from "./endstate-proof";
import { METRICS, distribution, type Report } from "./report";
import { RECORDED_BASELINES } from "./scale-targets";
import { DEFAULT_24H_SOAK_POLICY, evaluateSoakSamples, type SoakSample } from "./soak";

function tenXBenchmark(): Report {
  const base = RECORDED_BASELINES.S;
  const metrics = Object.fromEntries(METRICS.map(name => {
    const unit = name.endsWith("rss_bytes") ? "bytes"
      : name.endsWith("events_per_s") ? "events/s"
      : name.endsWith("writes_per_s") ? "writes/s"
      : name.endsWith("cpu_percent") ? "CPU %"
      : "ms";
    const direction = unit.endsWith("/s") ? "higher" as const : "lower" as const;
    const raw = base.medians[name]!;
    const value = unit === "bytes" ? raw : direction === "higher" ? raw * 10 : raw / 10;
    return [name, distribution(unit, [value, value, value], direction)];
  }));
  return {
    schema: "kizuki.benchmark/v1",
    profile: "full",
    machine: {
      cpu_count: 8, load_at_start: [0.1, 0.1, 0.1], bun_version: "1.3.14",
      git_sha: "c".repeat(40), platform: "linux", arch: "x64",
    },
    corpus: {
      size: "S", seed: 1, events: 1_000, max_events_per_topic: 256, topics: 4,
      canon_pages: 8, unwritten_claims: 996, unextracted_events: 984, input_sha256: "d".repeat(64),
    },
    protocol: {
      build_warmup: 1, build_repetitions: 3, read_warmup: 2, read_repetitions: 3,
      process_warmup: 2, process_repetitions: 3,
      idle_warmup: "initial due rails", idle_repetitions: 3, idle_window_ms: 60_000,
      idle_observed_ms: [60_001, 60_002, 60_003], retrieval: "lexical floor", principal: "owner",
    },
    metrics,
  };
}

function certified24hSoak() {
  const start = Date.parse("2026-11-26T00:00:00.000Z");
  const samples: SoakSample[] = [];
  for (let i = 0; i <= 1440; i++) {
    samples.push({
      at: new Date(start + i * 60_000).toISOString(),
      monotonic_ms: 5_000 + i * 60_000,
      boot_id: "boot-24h-pass",
      pid: 1234,
      instance_id: "inst-24h-pass",
      rss_bytes: 100 * 1024 * 1024,
      cpu_percent: 0.25,
      rails_ok: 1,
      rails_failed: 0,
      issues: [],
    });
  }
  return evaluateSoakSamples("full-24h", { ...DEFAULT_24H_SOAK_POLICY, sample_interval_ms: 60_000, max_gap_ms: 90_000 }, samples);
}

test("checkout end-state inventory finds all #1065 golden and benchmark files", () => {
  const inv = inspectEndStateFiles();
  expect(inv.all_present).toBe(true);
  expect(inv.golden.every(f => f.present && /^[0-9a-f]{64}$/.test(f.sha256 ?? ""))).toBe(true);
  expect(inv.bench.every(f => f.present && /^[0-9a-f]{64}$/.test(f.sha256 ?? ""))).toBe(true);
  expect(GOLDEN_1065_STAGES).toHaveLength(14);
});

test("end-state proof stays INCOMPLETE until all three pillars pass and never claims release credit", () => {
  const empty = evaluateEndStateProof();
  expect(empty.schema).toBe(ENDSTATE_PROOF_SCHEMA);
  expect(empty.release_credit).toBe(false);
  expect(empty.verdict).toBe("INCOMPLETE");
  expect(empty.golden_1065.status).toBe("UNRUN");
  expect(empty.scale_10x.status).toBe("UNRUN");
  expect(empty.soak_24h.status).toBe("UNRUN");

  const fullPass = evaluateEndStateProof({
    golden_runs: [
      { suite: "packages/mcp/test/golden-journey.test.ts", passed: true, tests_passed: 2, tests_failed: 0, duration_ms: 1200 },
      { suite: "packages/mcp/test/golden-rich-journey.test.ts", passed: true, tests_passed: 2, tests_failed: 0, duration_ms: 1500 },
    ],
    benchmark_report: tenXBenchmark(),
    soak_report: certified24hSoak(),
  });
  expect(fullPass.verdict).toBe("PASS");
  expect(fullPass.release_credit).toBe(false);
  expect(fullPass.golden_1065.status).toBe("PASS");
  expect(fullPass.scale_10x.status).toBe("PASS_10X");
  expect(fullPass.soak_24h.status).toBe("PASS_24H");
  expect(fullPass.soak_24h.certified_24h).toBe(true);

  const md = formatEndStateSummary(fullPass);
  expect(md).toContain("verdict: PASS");
  expect(md).not.toContain("\u2014");
});

test("any failed golden suite, regressed benchmark, or tampered soak report forces FAIL", () => {
  const failedGolden = evaluateEndStateProof({
    golden_runs: [
      { suite: "packages/mcp/test/golden-journey.test.ts", passed: false, tests_passed: 1, tests_failed: 1, duration_ms: 500 },
    ],
  });
  expect(failedGolden.verdict).toBe("FAIL");
  expect(failedGolden.golden_1065.status).toBe("FAIL");

  const forgedSoak = evaluateEndStateProof({
    soak_report: { ...certified24hSoak(), observed_ms: 999_999_999 },
  });
  expect(forgedSoak.verdict).toBe("FAIL");
  expect(forgedSoak.soak_24h.status).toBe("FAIL");
});

test("CLI inventory and smoke modes run end-to-end and write private artifacts outside repo", () => {
  const invProc = Bun.spawnSync([process.execPath, join(import.meta.dir, "endstate-proof.ts"), "--mode", "inventory"], {
    stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  expect(invProc.exitCode, invProc.stderr.toString()).toBe(0);
  const inv = JSON.parse(invProc.stdout.toString());
  expect(inv.all_present).toBe(true);

  const out = mkdtempSync(join(tmpdir(), "kizuki-endstate-cli-"));
  try {
    const smokeProc = Bun.spawnSync([process.execPath, join(import.meta.dir, "endstate-proof.ts"), "--mode", "smoke", "--out", out], {
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    expect(smokeProc.exitCode, smokeProc.stderr.toString()).toBe(0);
    const report = JSON.parse(readFileSync(join(out, "endstate-proof.json"), "utf8"));
    expect(report.schema).toBe(ENDSTATE_PROOF_SCHEMA);
    expect(report.release_credit).toBe(false);
    expect(report.verdict).toBe("INCOMPLETE");
    expect(report.soak_24h.status).toBe("SMOKE_PASS");
    expect(report.soak_24h.certified_24h).toBe(false);
    expect(statSync(join(out, "endstate-proof.json")).mode & 0o777).toBe(0o600);
    const md = readFileSync(join(out, "endstate-summary.md"), "utf8");
    expect(md).not.toContain("\u2014");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 40_000);
