import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { loadServeConfig } from "../../src/serve/config";
import { evaluateQualification, type QualificationProfile, type QualificationSample } from "../../src/serve/qualification";
import { runRail } from "../../src/serve/rails";
import { listRunReceipts } from "../../src/serve/receipts";
import { listSchedules } from "../../src/serve/schema";
import type { RailId } from "../../src/serve/types";

const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const START = Date.parse("2026-09-10T00:00:00.000Z");
const at = (ms: number) => new Date(START + ms).toISOString();
const PROCESS = { pid: 12, boot_id: "boot", start_ticks: "1", binary_sha256: "a".repeat(64), instance_id: "instance" };

/** An idle fixture vault whose schedules are anchored at the observation start. */
function fixture(serveToml?: string) {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-qualification-idle-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  if (serveToml !== undefined) writeFileSync(join(path, ".kizuki", "serve.toml"), serveToml);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  db.query("UPDATE schedules SET next_run_at = ?").run(at(0));
  const profile: QualificationProfile = {
    scope: "fixture", start_at: at(0), boot_id: "boot", monotonic_ms: 100,
    rails: listSchedules(db).map((row) => ({ rail: row.rail, period_s: row.period_s, jitter_s: row.jitter_s, next_run_at: row.next_run_at! })),
    brief_hour: loadServeConfig(path).brief_hour, timezone: "UTC", supervisor: "none", sampling_interval_ms: 30_000, max_gap_ms: 60_000, lateness_ms: 30_000,
  };
  return { path, db, profile };
}

/**
 * Drive an idle daemon's schedule once a minute for `minutes` and sample it as
 * the collector does: schedule rows first, then the receipts the journal holds.
 */
async function observe(
  { path, db, profile }: ReturnType<typeof fixture>,
  minutes: number,
  skip: (rail: RailId, minute: number) => boolean = () => false,
) {
  const samples: QualificationSample[] = [];
  let ticks = 0;
  for (let minute = 0; minute <= minutes; minute += 1) {
    const now = at(minute * 60_000);
    for (const row of listSchedules(db)) {
      if (row.next_run_at === null || row.next_run_at > now || skip(row.rail as RailId, minute)) continue;
      await runRail(db, path, row.rail as RailId, {
        now: () => now,
        execution: { instance_id: "instance", pid: 12, boot_id: "boot", trigger: "scheduled", due_at: row.next_run_at },
      });
      ticks += 1;
    }
    const schedules = listSchedules(db).map((row) => ({ rail: row.rail, period_s: row.period_s, last_run_at: row.last_run_at, next_run_at: row.next_run_at! }));
    const receipts = listRunReceipts(db).map((receipt) => ({
      run_id: receipt.run_id, sha256: "b".repeat(64), rail: receipt.rail, started_at: receipt.started_at, finished_at: receipt.finished_at,
      status: receipt.status, healthy: true, execution: receipt.execution ?? null,
    }));
    samples.push({ at: now, monotonic_ms: 100 + minute * 60_000, boot_id: "boot", supervisor: "not-observed", process: PROCESS, receipts, schedules, issues: [] });
  }
  return { samples, ticks, receipts: listRunReceipts(db).length, result: evaluateQualification(profile, samples) };
}

test("an idle daemon with no embedding port passes the observer without a receipt per slot", async () => {
  const idle = fixture();
  const { ticks, receipts, result } = await observe(idle, 130);
  expect(idle.profile.rails.find((rail) => rail.rail === "embed-backfill")!.period_s).toBe(60);
  expect(result.issues).toEqual([]);
  expect(result.automatic_runs).toBe(ticks);
  expect(receipts).toBeLessThan(ticks / 2);
  idle.db.close();
}, 60_000);

test("an idle daemon with an embedding port keeps the minute cadence and passes the observer", async () => {
  const idle = fixture('[ports]\nembedding = "kizuki.embedding.gguf"\n');
  const { ticks, receipts, result } = await observe(idle, 20);
  expect(result.issues).toEqual([]);
  expect(ticks).toBeGreaterThan(20);
  expect(receipts).toBeLessThan(ticks);
  idle.db.close();
}, 30_000);

test("a rail whose idle slots stop running is still reported missed", async () => {
  const idle = fixture();
  const { result } = await observe(idle, 60, (rail, minute) => rail === "retrieval-sweep" && minute >= 20);
  expect(result.issues).toContain("missed-rail-slot");
  idle.db.close();
}, 30_000);

test("a slot run late on the schedule row is not credited", async () => {
  const idle = fixture();
  const { samples } = await observe(idle, 16);
  const late = samples.map((sample) => ({
    ...sample,
    schedules: sample.schedules!.map((row) => (row.rail === "sync" && row.last_run_at !== null ? { ...row, last_run_at: at(2 * 3_600_000) } : row)),
  }));
  expect(evaluateQualification(idle.profile, late).issues).toContain("missed-rail-slot");
  idle.db.close();
}, 30_000);
