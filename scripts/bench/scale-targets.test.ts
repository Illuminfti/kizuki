import { expect, test } from "bun:test";
import { METRICS, distribution, type Report } from "./report";
import {
  RECORDED_BASELINES,
  baselineFromReport,
  compareBenchmarkReports,
  formatScaleComparison,
  targetForMetric,
} from "./scale-targets";

function reportFromBaseline(
  size: "S" | "M",
  opts: { profile?: "full" | "smoke"; factor?: number; rssFactor?: number; override?: Record<string, number> } = {},
): Report {
  const base = RECORDED_BASELINES[size];
  const profile = opts.profile ?? "full";
  const factor = opts.factor ?? 1;
  const rssFactor = opts.rssFactor ?? 1;
  const metrics = Object.fromEntries(METRICS.map(name => {
    const unit = name.endsWith("rss_bytes") ? "bytes"
      : name.endsWith("events_per_s") ? "events/s"
      : name.endsWith("writes_per_s") ? "writes/s"
      : name.endsWith("cpu_percent") ? "CPU %"
      : "ms";
    const direction = unit.endsWith("/s") ? "higher" as const : "lower" as const;
    if (profile === "smoke" && name === "serve.idle_cpu_percent") {
      return [name, {
        unit, direction, status: "omitted" as const, samples: [], p50: null, p95: null, p99: null,
        reason: "smoke skips the 60-second idle observation" as const,
      }];
    }
    const baselineValue = base.medians[name]!;
    const value = opts.override?.[name] !== undefined
      ? opts.override[name]!
      : unit === "bytes"
        ? Math.round(baselineValue * rssFactor)
        : direction === "higher"
          ? baselineValue * factor
          : baselineValue / factor;
    return [name, distribution(unit, [value, value, value], direction)];
  }));
  const events = size === "S" ? 1_000 : 20_000;
  const topics = Math.ceil(events / 256);
  return {
    schema: "kizuki.benchmark/v1",
    profile,
    machine: {
      cpu_count: 8, load_at_start: [0.5, 0.5, 0.5], bun_version: "1.3.14",
      git_sha: "a".repeat(40), platform: "linux", arch: "x64",
    },
    corpus: {
      size, seed: 1, events, max_events_per_topic: 256, topics,
      canon_pages: 2 * topics, unwritten_claims: events - topics,
      unextracted_events: events - topics - 1, input_sha256: "b".repeat(64),
    },
    protocol: {
      build_warmup: 1, build_repetitions: 3, read_warmup: 2, read_repetitions: 3,
      process_warmup: 2, process_repetitions: 3,
      idle_warmup: profile === "full" ? "initial due rails" : "omitted",
      idle_repetitions: profile === "full" ? 3 : 0,
      idle_window_ms: profile === "full" ? 60_000 : 0,
      idle_observed_ms: profile === "full" ? [60_001, 60_002, 60_003] : [],
      retrieval: "lexical floor", principal: "owner",
    },
    metrics,
  };
}

test("recorded S and M baselines cover the complete closed METRICS inventory", () => {
  for (const size of ["S", "M"] as const) {
    expect(Object.keys(RECORDED_BASELINES[size].medians).sort()).toEqual([...METRICS].sort());
  }
  expect(targetForMetric("events/s", "higher", 35.692)).toBeCloseTo(356.92, 3);
  expect(targetForMetric("ms", "lower", 182.221)).toBeCloseTo(18.2221, 4);
  expect(targetForMetric("CPU %", "lower", 0.778)).toBeCloseTo(0.0778, 4);
  expect(targetForMetric("bytes", "lower", 163_000_000)).toBeNull();
});

test("full report achieving 10x speedup with bounded RSS passes PASS_10X", () => {
  const candidate = reportFromBaseline("S", { factor: 10, rssFactor: 1.05 });
  const result = compareBenchmarkReports(candidate, RECORDED_BASELINES.S);
  expect(result.schema).toBe("kizuki.benchmark-scale-10x/v1");
  expect(result.verdict).toBe("PASS_10X");
  expect(result.summary.all_10x_met).toBe(true);
  expect(result.summary.all_non_regressed).toBe(true);
  expect(result.summary.regressed_count).toBe(0);
  expect(result.summary.met_10x_count).toBe(result.summary.targetable_10x_metrics);
  expect(result.summary.geometric_mean_speedup).toBeCloseTo(10, 2);
  const md = formatScaleComparison(result);
  expect(md).toContain("PASS_10X");
  expect(md).not.toContain("\u2014");
});

test("full report with moderate speedup passes non-regression without claiming 10x", () => {
  const candidate = reportFromBaseline("M", { factor: 2.5, rssFactor: 1.0 });
  const result = compareBenchmarkReports(candidate, RECORDED_BASELINES.M);
  expect(result.verdict).toBe("PASS_NO_REGRESSION");
  expect(result.summary.all_non_regressed).toBe(true);
  expect(result.summary.all_10x_met).toBe(false);
  expect(result.summary.geometric_mean_speedup).toBeCloseTo(2.5, 2);
});

test("latency, throughput, or RSS regression fails the scale comparison gate", () => {
  const slowSearch = reportFromBaseline("S", {
    factor: 10,
    override: { "mcp.search.wall_ms": RECORDED_BASELINES.S.medians["mcp.search.wall_ms"]! * 1.25 },
  });
  const res1 = compareBenchmarkReports(slowSearch, RECORDED_BASELINES.S);
  expect(res1.verdict).toBe("FAIL_REGRESSION");
  expect(res1.metrics.find(m => m.metric === "mcp.search.wall_ms")?.status).toBe("REGRESSED");

  const slowIngest = reportFromBaseline("S", {
    factor: 10,
    override: { "ingest.events_per_s": RECORDED_BASELINES.S.medians["ingest.events_per_s"]! * 0.5 },
  });
  const res2 = compareBenchmarkReports(slowIngest, RECORDED_BASELINES.S);
  expect(res2.verdict).toBe("FAIL_REGRESSION");
  expect(res2.metrics.find(m => m.metric === "ingest.events_per_s")?.status).toBe("REGRESSED");

  const rssLeak = reportFromBaseline("S", { factor: 10, rssFactor: 1.4 });
  const res3 = compareBenchmarkReports(rssLeak, RECORDED_BASELINES.S);
  expect(res3.verdict).toBe("FAIL_REGRESSION");
  expect(res3.metrics.find(m => m.metric === "daemon.drain_peak_rss_bytes")?.status).toBe("REGRESSED");
});

test("smoke profile never claims PASS_10X and rejects mismatched sizes or smoke baselines", () => {
  const smoke = reportFromBaseline("S", { profile: "smoke", factor: 12 });
  const result = compareBenchmarkReports(smoke, RECORDED_BASELINES.S);
  expect(result.verdict).toBe("SMOKE_NO_REGRESSION");
  expect(result.summary.all_10x_met).toBe(false);
  expect(result.summary.omitted_metrics).toBe(1);
  expect(() => baselineFromReport(smoke)).toThrow("full benchmark report");
  expect(() => compareBenchmarkReports(smoke, RECORDED_BASELINES.M)).toThrow("size mismatch");

  const fullS = reportFromBaseline("S", { factor: 2 });
  const customBase = baselineFromReport(fullS);
  const same = compareBenchmarkReports(fullS, customBase);
  expect(same.verdict).toBe("PASS_NO_REGRESSION");
  expect(same.summary.geometric_mean_speedup).toBeCloseTo(1, 3);
});
