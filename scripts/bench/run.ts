#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { OWNER, count, exportVault, listCanonPagesReport, restoreVault, runPurge, verifyPurge } from "../../packages/core/src/index";
import { openLedger, rebuildDerived } from "../../packages/core/src/internal";
import { createSource } from "./corpus";
import { measureReads } from "./reads";
import { CLI, ROOT, WORKER, cancelChildren, childEnvironment, command, stopChildren } from "./process";
import { SIZES, distribution, parseReport, reportJsonSchema, summary, type Metric, type Report, type Size } from "./report";

export function options(argv: string[]) {
  let size: Size = "S", seed = 1, out: string | undefined, smoke = false;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (seen.has(flag)) throw new Error("duplicate benchmark option");
    seen.add(flag);
    if (flag === "--smoke") { smoke = true; continue; }
    const value = argv[++index];
    if (value === undefined) throw new Error("benchmark option needs a value");
    if (flag === "--size" && Object.hasOwn(SIZES, value)) size = value as Size;
    else if (flag === "--seed" && /^\d{1,10}$/.test(value) && Number(value) <= 0xffffffff) seed = Number(value);
    else if (flag === "--out" && value.length > 0) out = value;
    else throw new Error("usage: bun scripts/bench/run.ts --size S|M|L|XL [--seed UINT32] [--out DIR] [--smoke]");
  }
  if (smoke && size !== "S") throw new Error("smoke requires size S");
  return { size, seed, out, smoke };
}

/** Resolve even a not-yet-created output through its nearest existing ancestor. */
export function outputDirectory(path: string): string {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, absolute));
  const inside = relative(realpathSync(ROOT), canonical);
  if (inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !inside.startsWith(sep))) throw new Error("benchmark reports must be outside the repository");
  for (const file of ["report.json", "summary.md", "report.schema.json"]) if (existsSync(join(canonical, file))) throw new Error("benchmark output already contains a report");
  mkdirSync(canonical, { recursive: true, mode: 0o700 });
  return canonical;
}

function record(metrics: Record<string, Metric>, name: string, unit: Metric["unit"], value: number, direction: Metric["direction"] = "lower") {
  const samples = metrics[name]?.samples ?? [];
  metrics[name] = distribution(unit, [...samples, value], direction);
}
function progress(stage: string) { process.stderr.write(`benchmark: ${stage}\n`); }

export async function runBenchmark(config: ReturnType<typeof options>, out: string): Promise<Report> {
  const machine = { cpu_count: cpus().length, load_at_start: loadavg(), bun_version: Bun.version,
    git_sha: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, env: childEnvironment() }).stdout.toString().trim(), platform: process.platform, arch: process.arch };
  const root = mkdtempSync(join(tmpdir(), "kizuki-bench-work-"));
  const source = join(root, "synthetic.sqlite");
  const events = SIZES[config.size];
  const warmup = config.smoke ? 0 : 1, repetitions = config.smoke ? 1 : 3;
  const readWarmup = config.smoke ? 1 : 2, readRepetitions = config.smoke ? 2 : 20;
  const processWarmup = config.smoke ? 0 : readWarmup, processRepetitions = config.smoke ? 1 : readRepetitions;
  const metrics: Record<string, Metric> = {};
  let vault = "", canonPages = 0, unwrittenClaims = 0, unextractedEvents = 0, observed = 0;
  try {
    progress("generate deterministic source");
    const digest = createSource(source, events, config.seed);
    for (let index = -warmup; index < repetitions; index++) {
      progress(`build ${index < 0 ? "warmup" : index + 1}`);
      const next = join(root, `build-${index}`);
      const built = await command([WORKER, "build", next, source, String(events)]);
      const result = JSON.parse(built.stdout) as { ingest_ms: number; drain_ms: number; drain_rss_bytes: number; writes: number; write_ms: number; cpu_ms: number; pages: number; unwritten_claims: number; unextracted_events: number };
      if (index >= 0) {
        record(metrics, "ingest.events_per_s", "events/s", events * 1000 / result.ingest_ms, "higher");
        record(metrics, "canon.writes_per_s", "writes/s", result.writes * 1000 / result.write_ms, "higher");
        record(metrics, "canon.cpu_ms_per_write", "ms", result.cpu_ms / result.writes);
        record(metrics, "daemon.drain_wall_ms", "ms", result.drain_ms);
        record(metrics, "daemon.drain_peak_rss_bytes", "bytes", result.drain_rss_bytes);
      }
      if (vault) rmSync(vault, { recursive: true, force: true });
      vault = next; canonPages = result.pages; unwrittenClaims = result.unwritten_claims; unextractedEvents = result.unextracted_events;
    }
    // The native read commands require the CLI's durable freshness cursor too.
    await command([CLI, "rebuild", "--layer", "search", "--max-records", String(2 * events + 5 * Math.ceil(events / 256)), "--max-source-bytes", String(events * 1024), "--json", "--vault", vault]);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try {
      rebuildDerived(db, vault);
      const page = listCanonPagesReport(vault).pages.find(page => page.data["type"] === "source");
      if (page === undefined) throw new Error("missing benchmark page");
      progress("warm MCP and cold process reads");
      Object.assign(metrics, await measureReads({ db, vaultPath: vault, principal: OWNER }, page.id, readWarmup, readRepetitions, processWarmup, processRepetitions));
      for (let index = -warmup; index < repetitions; index++) {
        progress(`maintenance ${index < 0 ? "warmup" : index + 1}`);
        const doctor = await command([CLI, "doctor", "--json", "--vault", vault], undefined, [0, 1]);
        const diagnostic = JSON.parse(doctor.stdout) as { schema?: string; data?: { ok?: boolean } };
        if (diagnostic.schema !== "kizuki.cli.doctor/v1" || typeof diagnostic.data?.ok !== "boolean") throw new Error("invalid doctor report");
        let started = performance.now();
        const backup = join(root, `export-${index}`);
        const exported = exportVault(db, vault, backup);
        const exportMs = performance.now() - started;
        if (!exported.complete || exported.snapshot.event_count !== events) throw new Error("export incomplete");
        const restored = join(root, `restore-${index}`);
        started = performance.now();
        restoreVault(backup, restored);
        const restoreMs = performance.now() - started;
        const restoredDb = openLedger(join(restored, ".kizuki", "kizuki.db"));
        let purgeMs: number;
        try {
          if (count(restoredDb) !== events || listCanonPagesReport(restored).pages.length !== canonPages) throw new Error("restore inventory mismatch");
          started = performance.now();
          const purged = await runPurge(restoredDb, restored, { source_record_id: "record-0000000", connector_id: "kizuki.import-legacy-events" }, "synthetic benchmark removal");
          purgeMs = performance.now() - started;
          const receipt = purged.receipts[0];
          if (receipt === undefined || purged.receipts.length !== 1 || count(restoredDb) !== events - 1 || !(await verifyPurge(restoredDb, restored, receipt.receipt_id)).ok) throw new Error("purge incomplete");
        } finally { restoredDb.close(); }
        started = performance.now();
        const rebuilt = rebuildDerived(db, vault);
        const rebuildMs = performance.now() - started;
        if (rebuilt.search.skipped.length > 0 || rebuilt.search.events !== events || rebuilt.search.pages !== canonPages) throw new Error("rebuild incomplete");
        if (index >= 0) {
          record(metrics, "doctor.wall_ms", "ms", doctor.wall_ms);
          record(metrics, "doctor.peak_rss_bytes", "bytes", doctor.rss_bytes);
          record(metrics, "export.wall_ms", "ms", exportMs);
          record(metrics, "restore.wall_ms", "ms", restoreMs);
          record(metrics, "purge.wall_ms", "ms", purgeMs);
          record(metrics, "rebuild.wall_ms", "ms", rebuildMs);
        }
        for (const directory of [backup, restored]) rmSync(directory, { recursive: true, force: true });
      }
    } finally { db.close(); }
    if (config.smoke) {
      metrics["serve.idle_cpu_percent"] = { unit: "CPU %", direction: "lower", status: "omitted", samples: [], p50: null, p95: null, p99: null, reason: "smoke skips the 60-second idle observation" };
    } else {
      progress("serve idle CPU: 60-second observation");
      const child = await command([WORKER, "idle", vault]);
      const idle = JSON.parse(child.stdout) as { observed_ms: number; cpu_percent: number };
      observed = idle.observed_ms;
      record(metrics, "serve.idle_cpu_percent", "CPU %", idle.cpu_percent);
    }
    const report = parseReport({ schema: "kizuki.benchmark/v1", profile: config.smoke ? "smoke" : "full", machine,
      corpus: { size: config.size, seed: config.seed, events, max_events_per_topic: 256, topics: Math.ceil(events / 256), canon_pages: canonPages, unwritten_claims: unwrittenClaims, unextracted_events: unextractedEvents, input_sha256: digest },
      protocol: { build_warmup: warmup, build_repetitions: repetitions, read_warmup: readWarmup, read_repetitions: readRepetitions, process_warmup: processWarmup, process_repetitions: processRepetitions, idle_observed_ms: observed, retrieval: "lexical floor", principal: "owner" }, metrics });
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    writeFileSync(join(out, "summary.md"), summary(report), { flag: "wx", mode: 0o600 });
    writeFileSync(join(out, "report.schema.json"), JSON.stringify(reportJsonSchema, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return report;
  } finally {
    await stopChildren();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const cancel = () => { void cancelChildren(); };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    const config = options(Bun.argv.slice(2));
    const out = outputDirectory(config.out ?? mkdtempSync(join(tmpdir(), "kizuki-bench-report-")));
    await runBenchmark(config, out);
    process.stdout.write(join(out, "report.json") + "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "benchmark failed"}\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}
