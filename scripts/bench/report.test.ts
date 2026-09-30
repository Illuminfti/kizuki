import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSource, sourceRow } from "./corpus";
import { options, outputDirectory } from "./run";
import { ROOT, childEnvironment, command } from "./process";
import { assertCliRead, assertRead } from "./reads";
import { METRICS, distribution, parseReport, percentile, type Report } from "./report";

function fullReport(): Report {
  const metrics = Object.fromEntries(METRICS.map(name => {
    const unit = name.endsWith("rss_bytes") ? "bytes" : name.endsWith("events_per_s") ? "events/s" : name.endsWith("writes_per_s") ? "writes/s" : name.endsWith("cpu_percent") ? "CPU %" : "ms";
    return [name, distribution(unit, [1, 2, 3], unit.endsWith("/s") ? "higher" : "lower")];
  }));
  return {
    schema: "kizuki.benchmark/v1", profile: "full",
    machine: { cpu_count: 4, load_at_start: [0, 0, 0], bun_version: "1.3.14", git_sha: "0".repeat(40), platform: "linux", arch: "x64" },
    corpus: { size: "S", seed: 1, events: 1_000, max_events_per_topic: 256, topics: 4, canon_pages: 8, unwritten_claims: 996, unextracted_events: 984, input_sha256: "0".repeat(64) },
    protocol: { build_warmup: 1, build_repetitions: 3, read_warmup: 2, read_repetitions: 3, process_warmup: 2, process_repetitions: 3,
      idle_warmup: "initial due rails", idle_repetitions: 3, idle_window_ms: 60_000, idle_observed_ms: [60_001, 60_002, 60_003], retrieval: "lexical floor", principal: "owner" },
    metrics,
  };
}

test("full reports retain repeated idle samples and a duration for each warmed observation", () => {
  const report = parseReport(fullReport());
  expect(report.metrics["serve.idle_cpu_percent"]).toMatchObject({ samples: [1, 2, 3], p50: 2, p95: 3, p99: 3 });
  expect(report.protocol.idle_observed_ms).toEqual([60_001, 60_002, 60_003]);
});

test("full idle measurements reject a single sample, short windows and inconsistent protocols", () => {
  const report = fullReport();
  for (const protocol of [
    { ...report.protocol, idle_repetitions: 1, idle_observed_ms: [60_001] },
    { ...report.protocol, idle_observed_ms: [60_001, 59_999, 60_003] },
    { ...report.protocol, idle_observed_ms: [60_001] },
    { ...report.protocol, idle_window_ms: 59_999 },
    { ...report.protocol, idle_warmup: "omitted" },
  ]) expect(() => parseReport({ ...report, protocol })).toThrow();
  expect(() => parseReport({ ...report, metrics: { ...report.metrics, "serve.idle_cpu_percent": distribution("CPU %", [1]) } })).toThrow();
});

test("smoke reports omit all idle observations and their warmup", () => {
  const report = fullReport();
  report.profile = "smoke";
  report.protocol = { ...report.protocol, idle_warmup: "omitted", idle_repetitions: 0, idle_window_ms: 0, idle_observed_ms: [] };
  report.metrics["serve.idle_cpu_percent"] = { unit: "CPU %", direction: "lower", status: "omitted", samples: [], p50: null, p95: null, p99: null, reason: "smoke skips the 60-second idle observation" };
  expect(parseReport(report)).toEqual(report);
  expect(() => parseReport({ ...report, protocol: { ...report.protocol, idle_observed_ms: [60_000] } })).toThrow();
  expect(() => parseReport({ ...report, protocol: { ...report.protocol, idle_repetitions: 1 } })).toThrow();
  expect(() => parseReport({ ...report, protocol: { ...report.protocol, idle_warmup: "initial due rails" } })).toThrow();
});

test("the seed reproduces the complete logical source; a different seed changes its hash", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-bench-source-test-"));
  try {
    const first = createSource(join(root, "first.sqlite"), 1_000, 1);
    expect(createSource(join(root, "second.sqlite"), 1_000, 1)).toBe(first);
    expect(createSource(join(root, "third.sqlite"), 1_000, 2)).not.toBe(first);
    expect(sourceRow(0, 1, 4).text).toBe(sourceRow(4, 1, 4).text);
    expect(sourceRow(0, 1, 4).record_id).not.toBe(sourceRow(4, 1, 4).record_id);
    expect(sourceRow(1, 1, 4).text).not.toBe(sourceRow(0, 1, 4).text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsafe and ambiguous arguments fail before creating a vault", () => {
  for (const argv of [["--size", "XXL"], ["--size", "M", "--smoke"], ["--seed", "-1"], ["--seed", "4294967296"], ["--seed", "1", "--seed", "2"], ["--out"], ["--unknown", "x"]]) expect(() => options(argv)).toThrow();
  expect(options(["--size", "XL", "--seed", "4294967295"])).toMatchObject({ size: "XL", seed: 4294967295, smoke: false });
});

test("output refuses repository paths including symlink aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-bench-path-test-"));
  try {
    expect(() => outputDirectory(join(ROOT, "bench-results"))).toThrow("outside the repository");
    symlinkSync(ROOT, join(root, "repository"), "dir");
    expect(() => outputDirectory(join(root, "repository", "nested", "result"))).toThrow("outside the repository");
    mkdirSync(join(root, "output"));
    expect(outputDirectory(join(root, "output"))).toBe(join(root, "output"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nearest-rank tails retain outliers and samples in their original order", () => {
  expect(percentile([], .5)).toBeNull();
  const samples = [100, 1, 2, 3, 4];
  expect(distribution("ms", samples)).toMatchObject({ samples: [100, 1, 2, 3, 4], p50: 3, p95: 100, p99: 100 });
});

test("a refused or empty read is never a successful fast benchmark", () => {
  expect(() => assertRead("search", { isError: true })).toThrow();
  expect(() => assertRead("get_page", { structuredContent: { canon: [] } })).toThrow();
  expect(() => assertRead("world_discovery", { structuredContent: { data: { matches: [] } } })).toThrow();
  expect(() => assertRead("graph_neighbors", { structuredContent: { data: { edges: [] } } })).toThrow();
  expect(() => assertCliRead("search", { schema: "kizuki.cli.query/v1", data: { hits: [] } })).toThrow();
  expect(() => assertCliRead("context_session", { schema: "kizuki.cli.context/v1", data: {} })).toThrow();
});

test("children receive only explicit runtime variables and no model credentials", () => {
  expect(Object.keys(childEnvironment()).sort()).toEqual(["KIZUKI_NO_SERVICE", "LANG", "PATH", "TMPDIR", "TZ", "XDG_CONFIG_HOME"]);
});

test("child peak RSS is normalized to bytes against a resident allocation", async () => {
  const retained = Buffer.alloc(256 * 1024 * 1024, 1);
  const result = await command(["-e", "const buffer=Buffer.alloc(64*1024*1024,1); console.log(process.memoryUsage().rss); console.log(buffer[0]);"]);
  const resident = Number(result.stdout.split("\n")[0]);
  expect(result.rss_bytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  expect(result.rss_bytes).toBeGreaterThan(resident * .8);
  expect(result.rss_bytes).toBeLessThan(resident * 2);
  expect(retained[0]).toBe(1);
});
