/** Deterministic 10x scale target comparison and non-regression gate over kizuki.benchmark/v1 reports. */
import { METRICS, SIZES, parseReport, type Metric, type Report, type Size } from "./report";

export type ScaleMetricStatus =
  | "PASS_10X"
  | "IMPROVED"
  | "WITHIN_TOLERANCE"
  | "REGRESSED"
  | "OMITTED";

export type ScaleVerdict =
  | "PASS_10X"
  | "PASS_NO_REGRESSION"
  | "SMOKE_NO_REGRESSION"
  | "FAIL_REGRESSION"
  | "INCOMPLETE";

export interface BaselineReference {
  source: "recorded-2026-09-30" | "report";
  git_sha: string;
  size: Size;
  seed: number;
  medians: Readonly<Record<string, number>>;
}

export interface ScaleComparisonPolicy {
  /** Allowed p50 regression percentage for latency/CPU/throughput before failing (default 10%). */
  regression_tolerance_pct: number;
  /** Maximum allowed peak RSS ratio relative to baseline before failing (default 1.25x). */
  max_rss_growth_ratio: number;
  /** Speedup multiplier required to mark a targetable metric as PASS_10X (default 10). */
  target_multiplier: number;
}

export const DEFAULT_SCALE_POLICY: Readonly<ScaleComparisonPolicy> = {
  regression_tolerance_pct: 10,
  max_rss_growth_ratio: 1.25,
  target_multiplier: 10,
};

/** Recorded 2026-09-30 baseline medians from docs/benchmarks.md (seed 1, commit 16cb4747...). */
const BASELINE_COMMIT_2026_09_30 = "16cb4747265db60d03250aef8cd859897dd1ef38";
const MIB = 1024 * 1024;

export const RECORDED_BASELINES: Readonly<Record<"S" | "M", BaselineReference>> = {
  S: {
    source: "recorded-2026-09-30",
    git_sha: BASELINE_COMMIT_2026_09_30,
    size: "S",
    seed: 1,
    medians: {
      "ingest.events_per_s": 35.692,
      "canon.writes_per_s": 2.000,
      "canon.cpu_ms_per_write": 170.255,
      "daemon.drain_wall_ms": 28282.082,
      "daemon.drain_peak_rss_bytes": Math.round(163.539 * MIB),
      "mcp.search.wall_ms": 182.221,
      "cold_mcp.search.wall_ms": 868.865,
      "mcp.context_session.wall_ms": 82.312,
      "cold_mcp.context_session.wall_ms": 1156.977,
      "mcp.context_query.wall_ms": 152.696,
      "cold_mcp.context_query.wall_ms": 1279.583,
      "mcp.get_page.wall_ms": 35.731,
      "cold_mcp.get_page.wall_ms": 710.592,
      "mcp.timeline.wall_ms": 65.821,
      "cold_mcp.timeline.wall_ms": 768.283,
      "mcp.world_discovery.wall_ms": 41.917,
      "cold_mcp.world_discovery.wall_ms": 730.755,
      "mcp.graph_neighbors.wall_ms": 21.405,
      "cold_mcp.graph_neighbors.wall_ms": 681.953,
      "cold_cli.search.wall_ms": 918.697,
      "cold_cli.context_session.wall_ms": 1289.344,
      "cold_cli.context_query.wall_ms": 1302.096,
      "cold_cli.world_discovery.wall_ms": 724.018,
      "doctor.wall_ms": 968.886,
      "doctor.peak_rss_bytes": Math.round(137.063 * MIB),
      "export.wall_ms": 2779.390,
      "restore.wall_ms": 2865.568,
      "purge.wall_ms": 1269.766,
      "rebuild.wall_ms": 270.201,
      "serve.idle_cpu_percent": 0.778,
    },
  },
  M: {
    source: "recorded-2026-09-30",
    git_sha: BASELINE_COMMIT_2026_09_30,
    size: "M",
    seed: 1,
    medians: {
      "ingest.events_per_s": 23.826,
      "canon.writes_per_s": 0.830,
      "canon.cpu_ms_per_write": 868.856,
      "daemon.drain_wall_ms": 839634.088,
      "daemon.drain_peak_rss_bytes": Math.round(239.008 * MIB),
      "mcp.search.wall_ms": 990.223,
      "cold_mcp.search.wall_ms": 1301.937,
      "mcp.context_session.wall_ms": 321.861,
      "cold_mcp.context_session.wall_ms": 823.155,
      "mcp.context_query.wall_ms": 435.277,
      "cold_mcp.context_query.wall_ms": 1026.307,
      "mcp.get_page.wall_ms": 35.370,
      "cold_mcp.get_page.wall_ms": 358.254,
      "mcp.timeline.wall_ms": 274.502,
      "cold_mcp.timeline.wall_ms": 556.291,
      "mcp.world_discovery.wall_ms": 83.890,
      "cold_mcp.world_discovery.wall_ms": 404.445,
      "mcp.graph_neighbors.wall_ms": 18.374,
      "cold_mcp.graph_neighbors.wall_ms": 355.208,
      "cold_cli.search.wall_ms": 1260.057,
      "cold_cli.context_session.wall_ms": 865.851,
      "cold_cli.context_query.wall_ms": 1124.169,
      "cold_cli.world_discovery.wall_ms": 656.682,
      "doctor.wall_ms": 1096.763,
      "doctor.peak_rss_bytes": Math.round(162.324 * MIB),
      "export.wall_ms": 117296.101,
      "restore.wall_ms": 18385.026,
      "purge.wall_ms": 5922.647,
      "rebuild.wall_ms": 2789.140,
      "serve.idle_cpu_percent": 1.455,
    },
  },
};

export interface MetricScaleResult {
  metric: string;
  unit: Metric["unit"];
  direction: Metric["direction"];
  targetable_10x: boolean;
  baseline_p50: number;
  candidate_p50: number | null;
  target_10x: number | null;
  speedup_ratio: number | null;
  meets_10x: boolean;
  regressed: boolean;
  status: ScaleMetricStatus;
}

export interface ScaleComparisonReport {
  schema: "kizuki.benchmark-scale-10x/v1";
  size: Size;
  seed: number;
  candidate_profile: Report["profile"];
  candidate_git_sha: string;
  baseline_source: BaselineReference["source"];
  baseline_git_sha: string;
  policy: ScaleComparisonPolicy;
  summary: {
    total_metrics: number;
    measured_metrics: number;
    omitted_metrics: number;
    targetable_10x_metrics: number;
    met_10x_count: number;
    regressed_count: number;
    geometric_mean_speedup: number | null;
    all_non_regressed: boolean;
    all_10x_met: boolean;
  };
  verdict: ScaleVerdict;
  metrics: MetricScaleResult[];
}

export function baselineFromReport(raw: unknown): BaselineReference {
  const report = parseReport(raw);
  if (report.profile !== "full") {
    throw new Error("scale baseline must be a full benchmark report");
  }
  const medians: Record<string, number> = {};
  for (const name of METRICS) {
    const metric = report.metrics[name];
    if (metric === undefined || metric.status !== "measured" || metric.p50 === null) {
      throw new Error(`scale baseline missing measured metric: ${name}`);
    }
    medians[name] = metric.p50;
  }
  return {
    source: "report",
    git_sha: report.machine.git_sha,
    size: report.corpus.size,
    seed: report.corpus.seed,
    medians,
  };
}

export function targetForMetric(
  unit: Metric["unit"],
  direction: Metric["direction"],
  baselineP50: number,
  multiplier = DEFAULT_SCALE_POLICY.target_multiplier,
): number | null {
  if (!Number.isFinite(baselineP50) || baselineP50 < 0 || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error("invalid scale target inputs");
  }
  if (unit === "bytes") return null;
  return direction === "higher" ? baselineP50 * multiplier : baselineP50 / multiplier;
}

function validatePolicy(policy: ScaleComparisonPolicy): ScaleComparisonPolicy {
  if (
    !Number.isFinite(policy.regression_tolerance_pct) || policy.regression_tolerance_pct < 0 || policy.regression_tolerance_pct > 100 ||
    !Number.isFinite(policy.max_rss_growth_ratio) || policy.max_rss_growth_ratio < 1 ||
    !Number.isFinite(policy.target_multiplier) || policy.target_multiplier < 1
  ) {
    throw new Error("invalid scale comparison policy");
  }
  return { ...policy };
}

function validateBaseline(baseline: BaselineReference): void {
  if (!Object.hasOwn(SIZES, baseline.size) || !/^[0-9a-f]{40}$/.test(baseline.git_sha)) {
    throw new Error("invalid scale baseline metadata");
  }
  for (const name of METRICS) {
    const value = baseline.medians[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`invalid scale baseline median for ${name}`);
    }
  }
}

export function compareBenchmarkReports(
  candidateRaw: unknown,
  baseline: BaselineReference,
  policyInput: Partial<ScaleComparisonPolicy> = {},
): ScaleComparisonReport {
  const candidate = parseReport(candidateRaw);
  const policy = validatePolicy({ ...DEFAULT_SCALE_POLICY, ...policyInput });
  validateBaseline(baseline);

  if (candidate.corpus.size !== baseline.size) {
    throw new Error(`scale comparison size mismatch: candidate=${candidate.corpus.size} baseline=${baseline.size}`);
  }
  if (candidate.corpus.seed !== baseline.seed) {
    throw new Error(`scale comparison seed mismatch: candidate=${candidate.corpus.seed} baseline=${baseline.seed}`);
  }

  const toleranceFactor = 1 + policy.regression_tolerance_pct / 100;
  const rows: MetricScaleResult[] = [];
  const logSpeedups: number[] = [];
  let measured = 0;
  let omitted = 0;
  let targetable = 0;
  let met10x = 0;
  let regressed = 0;

  for (const name of METRICS) {
    const metric = candidate.metrics[name]!;
    const base = baseline.medians[name]!;
    const isRss = metric.unit === "bytes";
    const targetable10x = !isRss;
    if (targetable10x) targetable++;
    const target = targetForMetric(metric.unit, metric.direction, base, policy.target_multiplier);

    if (metric.status === "omitted" || metric.p50 === null) {
      omitted++;
      rows.push({
        metric: name,
        unit: metric.unit,
        direction: metric.direction,
        targetable_10x: targetable10x,
        baseline_p50: base,
        candidate_p50: null,
        target_10x: target,
        speedup_ratio: null,
        meets_10x: false,
        regressed: false,
        status: "OMITTED",
      });
      continue;
    }

    measured++;
    const value = metric.p50;
    let speedup: number;
    let isRegressed: boolean;
    let meets10x = false;

    if (isRss) {
      speedup = value === 0 ? (base === 0 ? 1 : Number.POSITIVE_INFINITY) : base / value;
      isRegressed = base > 0 ? value > base * policy.max_rss_growth_ratio : value > 0;
    } else if (metric.direction === "higher") {
      speedup = base === 0 ? (value === 0 ? 1 : policy.target_multiplier) : value / base;
      isRegressed = value < base / toleranceFactor;
      meets10x = target !== null && value >= target;
    } else {
      speedup = value === 0 ? (base === 0 ? 1 : policy.target_multiplier) : base / value;
      isRegressed = base === 0 ? value > 0 : value > base * toleranceFactor;
      meets10x = target !== null && value <= target;
    }

    if (targetable10x && Number.isFinite(speedup) && speedup > 0) {
      logSpeedups.push(Math.log(speedup));
    }
    if (meets10x) met10x++;
    if (isRegressed) regressed++;

    const status: ScaleMetricStatus = isRegressed
      ? "REGRESSED"
      : meets10x
        ? "PASS_10X"
        : speedup > 1
          ? "IMPROVED"
          : "WITHIN_TOLERANCE";

    rows.push({
      metric: name,
      unit: metric.unit,
      direction: metric.direction,
      targetable_10x: targetable10x,
      baseline_p50: base,
      candidate_p50: value,
      target_10x: target,
      speedup_ratio: Number.isFinite(speedup) ? Number(speedup.toFixed(4)) : null,
      meets_10x: meets10x,
      regressed: isRegressed,
      status,
    });
  }

  const geoMean = logSpeedups.length > 0
    ? Number(Math.exp(logSpeedups.reduce((acc, item) => acc + item, 0) / logSpeedups.length).toFixed(4))
    : null;
  const allNonRegressed = regressed === 0;
  const all10xMet = candidate.profile === "full" && omitted === 0 && met10x === targetable && allNonRegressed;

  let verdict: ScaleVerdict;
  if (!allNonRegressed) verdict = "FAIL_REGRESSION";
  else if (candidate.profile === "smoke") verdict = "SMOKE_NO_REGRESSION";
  else if (omitted > 0) verdict = "INCOMPLETE";
  else if (all10xMet) verdict = "PASS_10X";
  else verdict = "PASS_NO_REGRESSION";

  return {
    schema: "kizuki.benchmark-scale-10x/v1",
    size: candidate.corpus.size,
    seed: candidate.corpus.seed,
    candidate_profile: candidate.profile,
    candidate_git_sha: candidate.machine.git_sha,
    baseline_source: baseline.source,
    baseline_git_sha: baseline.git_sha,
    policy,
    summary: {
      total_metrics: rows.length,
      measured_metrics: measured,
      omitted_metrics: omitted,
      targetable_10x_metrics: targetable,
      met_10x_count: met10x,
      regressed_count: regressed,
      geometric_mean_speedup: geoMean,
      all_non_regressed: allNonRegressed,
      all_10x_met: all10xMet,
    },
    verdict,
    metrics: rows,
  };
}

function fmt(value: number | null, digits = 3): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

export function formatScaleComparison(report: ScaleComparisonReport): string {
  const rows = report.metrics.map(row =>
    `| ${row.metric} | ${row.unit} | ${fmt(row.baseline_p50)} | ${fmt(row.candidate_p50)} | ${fmt(row.target_10x)} | ${row.speedup_ratio === null ? "n/a" : `${row.speedup_ratio.toFixed(2)}x`} | ${row.status} |`,
  );
  return [
    "# Scale 10x benchmark comparison",
    "",
    `Schema: ${report.schema}; verdict: ${report.verdict}; profile: ${report.candidate_profile}; size: ${report.size}; seed: ${report.seed}.`,
    `Candidate git: ${report.candidate_git_sha}; baseline (${report.baseline_source}): ${report.baseline_git_sha}.`,
    `Measured: ${report.summary.measured_metrics}/${report.summary.total_metrics}; 10x targets met: ${report.summary.met_10x_count}/${report.summary.targetable_10x_metrics}; regressions: ${report.summary.regressed_count}; geomean speedup: ${report.summary.geometric_mean_speedup === null ? "n/a" : `${report.summary.geometric_mean_speedup.toFixed(2)}x`}.`,
    "",
    "| Metric | Unit | Baseline p50 | Candidate p50 | 10x target | Speedup | Status |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "",
  ].join("\n");
}
