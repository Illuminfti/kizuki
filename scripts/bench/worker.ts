import { join } from "node:path";
import {
  count, countUnwrittenLiveClaims, createBudgetTracker, listCanonPagesReport,
  runServeDaemon, runToCompletion, runWritePass,
} from "../../packages/core/src/index";
import { openLedger } from "../../packages/core/src/internal";
import { LEGACY_EVENTS_CONNECTOR_ID } from "../../packages/connectors/src/index";
import { MODEL, SOURCE_KEY, connector, createVault, scriptedProducer } from "./corpus";
import { nativePeakRssBytes } from "./process";

async function build(vault: string, source: string, events: number) {
  createVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const producer = scriptedProducer(vault);
  try {
    const imported = await drain(db, vault, source, events);
    const extraction = {
      max_calls_per_pass: 256, records_per_request: 8, max_input_tokens: 32_000, max_output_tokens: 8_192,
      max_pass_seconds: 600, max_calls_per_day: 100_000, max_output_tokens_per_day: 1_000_000_000,
    };
    // Real per-day limits remain in force. A long local run can span synthetic budget days.
    let budgetDay = 0;
    let calls = 0;
    const now = () => new Date(Date.now() + budgetDay * 86_400_000).toISOString();
    const extractionStart = performance.now();
    for (;;) {
      const pass = await runWritePass(db, vault, { budget: createBudgetTracker({ canon_writes_per_run: 0 }), producer, claims: { db }, extraction, now });
      calls += pass.model.calls;
      if (pass.stopped === "model:budget_day" && pass.errors.every(error => error.startsWith("model budget:"))) { budgetDay++; continue; }
      if (pass.errors.length > 0) throw new Error("synthetic extraction refused");
      if (pass.stopped !== null) throw new Error("synthetic extraction stopped");
      if (pass.model.calls === 0) break;
    }
    const extractionMs = performance.now() - extractionStart;
    let writes = 0;
    const target = 2 * Math.ceil(events / 256);
    const writeStart = performance.now(), cpuStart = process.cpuUsage();
    while (writes < target) {
      const pass = await runWritePass(db, vault, {
        budget: createBudgetTracker({ canon_writes_per_run: Math.min(32, target - writes) }), producer, model_ref: MODEL, claims: { db }, extraction, now,
      });
      if (pass.errors.length > 0 || (pass.stopped !== null && pass.stopped !== "budget:canon_writes_per_run") || pass.canon_writes === 0) throw new Error(`synthetic canon materialization refused: ${pass.stopped ?? pass.errors.join(",")}`);
      writes += pass.canon_writes;
    }
    const writeMs = performance.now() - writeStart, cpu = process.cpuUsage(cpuStart);
    const pages = listCanonPagesReport(vault);
    if (pages.skipped.length > 0 || pages.pages.length !== 2 * Math.ceil(events / 256)) throw new Error("synthetic canon inventory mismatch");
    return { ingest_ms: imported.ingest_ms, drain_ms: imported.wall_ms, drain_rss_bytes: imported.rss_bytes, extraction_ms: extractionMs, model_calls: calls, writes, write_ms: writeMs, cpu_ms: (cpu.user + cpu.system) / 1000, pages: pages.pages.length, unwritten_claims: countUnwrittenLiveClaims(db) };
  } finally { await producer.close(); db.close(); }
}
async function ingest(db: ReturnType<typeof openLedger>, vault: string, source: string, events: number) {
  const importer = connector(source);
  const started = performance.now();
  await importer.connect(async () => { throw new Error("benchmark has no secrets"); });
  const result = await runToCompletion(db, importer, LEGACY_EVENTS_CONNECTOR_ID, SOURCE_KEY, "backfill", { vault_path: vault, maxBatches: Math.ceil(events / 128) + 10 });
  if (result.errors.length > 0 || result.stored !== events || result.duplicates !== 0 || count(db) !== events) throw new Error("synthetic connector drain refused");
  return { wall_ms: performance.now() - started, stored: result.stored };
}
async function drain(db: ReturnType<typeof openLedger>, vault: string, source: string, events: number) {
  const started = performance.now();
  let stored = 0, ingestMs = 0;
  await runServeDaemon(db, vault, { http: false, once: true, rails: ["sync"], hooks: {
    async sync() {
      const result = await ingest(db, vault, source, events);
      stored = result.stored;
      ingestMs = result.wall_ms;
      return { events_synced: stored, events_stored: stored, events_duplicate: 0, events_self_skipped: 0, errors: [] };
    },
  } });
  if (stored !== events) throw new Error("daemon drain incomplete");
  return { wall_ms: performance.now() - started, ingest_ms: ingestMs, rss_bytes: nativePeakRssBytes(process.resourceUsage().maxRSS) };
}
async function idle(vault: string, durationMs: number) {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  let start = 0;
  let cpuStart: ReturnType<typeof process.cpuUsage> | undefined;
  // Startup and the first due rails finish before the idle window starts. Keep the actual 1 s sleep.
  try {
    await runServeDaemon(db, vault, {
      http: false,
      shouldContinue: () => start === 0 || performance.now() - start < durationMs,
      sleep: async ms => {
        if (start === 0) { start = performance.now(); cpuStart = process.cpuUsage(); }
        await Bun.sleep(ms);
      },
    });
    if (cpuStart === undefined) throw new Error("idle observation did not start");
    const observed = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    return { observed_ms: observed, cpu_percent: (cpu.user + cpu.system) / (observed * 10) };
  } finally { db.close(); }
}

if (import.meta.main) {
  const [operation, vault, source, events] = Bun.argv.slice(2);
  try {
    if (vault === undefined) throw new Error("worker vault required");
    const result = operation === "build" && source !== undefined ? await build(vault, source, Number(events))
      : operation === "idle" ? await idle(vault, 60_000) : (() => { throw new Error("unknown benchmark worker"); })();
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`benchmark worker failed: ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  }
}
