#!/usr/bin/env bun
/** Unified M10 end-state proof evaluator: #1065 golden journey, scale 10x benchmark, and 24h soak. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initVault } from "../../packages/core/src/vault/init";
import { openLedger } from "../../packages/core/src/ledger/db";
import { initServe } from "../../packages/core/src/serve/schema";
import { ROOT } from "./process";
import { outputDirectory } from "./run";
import { compareBenchmarkReports, RECORDED_BASELINES, type BaselineReference, type ScaleComparisonReport } from "./scale-targets";
import { parseSoakReport, runSoakProbe, SOAK_WINDOW_MS, type SoakReport } from "./soak";

export const ENDSTATE_PROOF_SCHEMA = "kizuki.endstate-proof/v1" as const;

export const GOLDEN_1065_FILES = [
  "packages/mcp/test/golden-journey.test.ts",
  "packages/mcp/test/golden-rich-journey.test.ts",
  "packages/mcp/test/helpers/golden-journey.ts",
] as const;

export const GOLDEN_1065_STAGES = [
  "local-only-capture",
  "explicit-model-extraction",
  "envelope-v1-v2-parity",
  "cross-principal-share-resume",
  "evidence-span-expansion",
  "consolidation-lag-staleness-refusal",
  "world-diff-and-atlas",
  "artifact-version-digest-and-expansion",
  "task-slice-and-budget-refusal",
  "owner-correction-and-receipt-undo",
  "grant-narrowing-invalidation",
  "world-rebuild-and-backup-restore",
  "source-revocation-and-physical-erasure",
  "rich-decision-procedure-attention-outcome",
] as const;

export const ENDSTATE_BENCH_FILES = [
  "scripts/bench/run.ts",
  "scripts/bench/report.ts",
  "scripts/bench/scale-targets.ts",
  "scripts/bench/soak.ts",
  "scripts/bench/endstate-proof.ts",
] as const;

export interface TrackedFileDigest {
  path: string;
  present: boolean;
  sha256: string | null;
}

export interface GoldenRunResult {
  suite: string;
  passed: boolean;
  tests_passed: number;
  tests_failed: number;
  duration_ms: number;
}

export interface EndStateProofInput {
  root?: string;
  golden_runs?: readonly GoldenRunResult[];
  benchmark_report?: unknown;
  benchmark_baseline?: BaselineReference;
  soak_report?: unknown;
}

export type EndStateVerdict = "PASS" | "FAIL" | "INCOMPLETE";

export interface EndStateProofReport {
  schema: typeof ENDSTATE_PROOF_SCHEMA;
  release_credit: false;
  verdict: EndStateVerdict;
  golden_1065: {
    status: "PASS" | "FAIL" | "UNRUN";
    files: TrackedFileDigest[];
    stages: readonly string[];
    runs: GoldenRunResult[];
    issues: string[];
  };
  scale_10x: {
    status: "PASS_10X" | "PASS_NO_REGRESSION" | "SMOKE_NO_REGRESSION" | "FAIL" | "UNRUN";
    comparison: ScaleComparisonReport | null;
    issues: string[];
  };
  soak_24h: {
    status: "PASS_24H" | "SMOKE_PASS" | "INCOMPLETE" | "FAIL" | "UNRUN";
    required_window_ms: number;
    certified_24h: boolean;
    report: Omit<SoakReport, "samples"> | null;
    issues: string[];
  };
}

function sha256File(root: string, relativePath: string): TrackedFileDigest {
  const full = resolve(root, relativePath);
  if (!full.startsWith(`${resolve(root)}/`)) {
    throw new Error(`path outside checkout: ${relativePath}`);
  }
  if (!existsSync(full)) return { path: relativePath, present: false, sha256: null };
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { path: relativePath, present: false, sha256: null };
  }
  const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
  return { path: relativePath, present: true, sha256: digest };
}

export function inspectEndStateFiles(root = ROOT): {
  golden: TrackedFileDigest[];
  bench: TrackedFileDigest[];
  all_present: boolean;
} {
  const golden = GOLDEN_1065_FILES.map(path => sha256File(root, path));
  const bench = ENDSTATE_BENCH_FILES.map(path => sha256File(root, path));
  return {
    golden,
    bench,
    all_present: [...golden, ...bench].every(item => item.present),
  };
}

function evaluateGolden(root: string, runs: readonly GoldenRunResult[] | undefined): EndStateProofReport["golden_1065"] {
  const files = GOLDEN_1065_FILES.map(path => sha256File(root, path));
  const issues: string[] = [];
  for (const file of files) {
    if (!file.present) issues.push(`missing-golden-file:${file.path}`);
  }
  const normalizedRuns = (runs ?? []).map(row => ({
    suite: row.suite,
    passed: row.passed,
    tests_passed: row.tests_passed,
    tests_failed: row.tests_failed,
    duration_ms: row.duration_ms,
  }));
  if (issues.length > 0) {
    return { status: "FAIL", files, stages: GOLDEN_1065_STAGES, runs: normalizedRuns, issues };
  }
  if (normalizedRuns.length === 0) {
    return { status: "UNRUN", files, stages: GOLDEN_1065_STAGES, runs: [], issues: ["golden-suites-not-executed"] };
  }
  const requiredSuites = [
    "packages/mcp/test/golden-journey.test.ts",
    "packages/mcp/test/golden-rich-journey.test.ts",
  ];
  const bySuite = new Map(normalizedRuns.map(item => [item.suite, item]));
  for (const suite of requiredSuites) {
    const run = bySuite.get(suite);
    if (!run) issues.push(`missing-golden-run:${suite}`);
    else if (!run.passed || run.tests_failed > 0 || run.tests_passed < 1) issues.push(`golden-suite-failed:${suite}`);
  }
  return {
    status: issues.length === 0 ? "PASS" : "FAIL",
    files,
    stages: GOLDEN_1065_STAGES,
    runs: normalizedRuns,
    issues,
  };
}

function evaluateScale(report: unknown, baseline?: BaselineReference): EndStateProofReport["scale_10x"] {
  if (report === undefined) {
    return { status: "UNRUN", comparison: null, issues: ["benchmark-report-not-supplied"] };
  }
  try {
    const inferredSize =
      report !== null && typeof report === "object" && "corpus" in report &&
      report.corpus !== null && typeof report.corpus === "object" && "size" in report.corpus
        ? (report.corpus as { size?: unknown }).size
        : undefined;
    const ref = baseline ?? (inferredSize === "M" ? RECORDED_BASELINES.M : RECORDED_BASELINES.S);
    const comparison = compareBenchmarkReports(report, ref);
    if (comparison.verdict === "FAIL_REGRESSION") {
      return { status: "FAIL", comparison, issues: ["benchmark-regression-detected"] };
    }
    if (comparison.verdict === "INCOMPLETE") {
      return { status: "UNRUN", comparison, issues: ["benchmark-incomplete"] };
    }
    return { status: comparison.verdict, comparison, issues: [] };
  } catch (error) {
    return {
      status: "FAIL",
      comparison: null,
      issues: [error instanceof Error ? error.message : "invalid-benchmark-report"],
    };
  }
}

function evaluateSoak(report: unknown): EndStateProofReport["soak_24h"] {
  if (report === undefined) {
    return {
      status: "UNRUN",
      required_window_ms: SOAK_WINDOW_MS,
      certified_24h: false,
      report: null,
      issues: ["soak-report-not-supplied"],
    };
  }
  try {
    const validated = parseSoakReport(report);
    const { samples: _samples, ...summaryReport } = validated;
    return {
      status: validated.status,
      required_window_ms: SOAK_WINDOW_MS,
      certified_24h: validated.soak_24h_certified,
      report: summaryReport,
      issues: [...validated.issues],
    };
  } catch (error) {
    return {
      status: "FAIL",
      required_window_ms: SOAK_WINDOW_MS,
      certified_24h: false,
      report: null,
      issues: [error instanceof Error ? error.message : "invalid-soak-report"],
    };
  }
}

export function evaluateEndStateProof(input: EndStateProofInput = {}): EndStateProofReport {
  const root = input.root ?? ROOT;
  const golden_1065 = evaluateGolden(root, input.golden_runs);
  const scale_10x = evaluateScale(input.benchmark_report, input.benchmark_baseline);
  const soak_24h = evaluateSoak(input.soak_report);

  let verdict: EndStateVerdict;
  if (golden_1065.status === "FAIL" || scale_10x.status === "FAIL" || soak_24h.status === "FAIL") {
    verdict = "FAIL";
  } else if (
    golden_1065.status === "PASS" &&
    scale_10x.status === "PASS_10X" &&
    soak_24h.status === "PASS_24H" &&
    soak_24h.certified_24h
  ) {
    verdict = "PASS";
  } else {
    verdict = "INCOMPLETE";
  }

  return {
    schema: ENDSTATE_PROOF_SCHEMA,
    release_credit: false,
    verdict,
    golden_1065,
    scale_10x,
    soak_24h,
  };
}

export function formatEndStateSummary(proof: EndStateProofReport): string {
  return [
    "# End-State Proof Summary (#1065, Scale 10x, 24h Soak)",
    "",
    `Schema: ${proof.schema}; verdict: ${proof.verdict}; release credit: ${proof.release_credit}.`,
    `- Golden journey (#1065): ${proof.golden_1065.status} (${proof.golden_1065.files.filter(f => f.present).length}/${proof.golden_1065.files.length} files, ${proof.golden_1065.stages.length} stages, ${proof.golden_1065.runs.length} recorded suite runs)`,
    `- Scale 10x benchmark: ${proof.scale_10x.status}${proof.scale_10x.comparison ? ` (geomean ${proof.scale_10x.comparison.summary.geometric_mean_speedup ?? "n/a"}x, regressions ${proof.scale_10x.comparison.summary.regressed_count})` : ""}`,
    `- Continuous 24h soak: ${proof.soak_24h.status} (certified_24h=${proof.soak_24h.certified_24h}, required=${proof.soak_24h.required_window_ms} ms)`,
    "",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): { mode: "inventory" | "smoke"; out: string | undefined } {
  let mode: "inventory" | "smoke" = "inventory";
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--mode") {
      const value = argv[++i];
      if (value !== "inventory" && value !== "smoke") throw new Error("usage: bun scripts/bench/endstate-proof.ts --mode inventory|smoke [--out DIR]");
      mode = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a directory");
      out = value;
    } else {
      throw new Error("usage: bun scripts/bench/endstate-proof.ts --mode inventory|smoke [--out DIR]");
    }
  }
  return { mode, out };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.mode === "inventory") {
      process.stdout.write(JSON.stringify(inspectEndStateFiles(ROOT), null, 2) + "\n");
    } else {
      const scratch = mkdtempSync(join(tmpdir(), "kizuki-endstate-smoke-"));
      try {
        const vault = join(scratch, "vault");
        initVault(vault);
        const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
        try { initServe(db); } finally { db.close(); }
        const soak = await runSoakProbe(vault, { profile: "smoke", window_ms: 1200, sample_interval_ms: 300 });
        const proof = evaluateEndStateProof({ root: ROOT, soak_report: soak });
        if (args.out) {
          const dir = outputDirectory(args.out);
          writeFileSync(join(dir, "endstate-proof.json"), JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
          writeFileSync(join(dir, "endstate-summary.md"), formatEndStateSummary(proof), { flag: "wx", mode: 0o600 });
        }
        process.stdout.write(JSON.stringify(proof, null, 2) + "\n");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "endstate-proof failed"}\n`);
    process.exitCode = 1;
  }
}
