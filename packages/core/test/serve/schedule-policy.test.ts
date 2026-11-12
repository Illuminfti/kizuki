import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { loadServeConfig } from "../../src/serve/config";
import { runServeDaemon } from "../../src/serve/daemon";
import { dueRails } from "../../src/serve/rails";
import { listRunReceipts, nextScheduleSlot, persistRunReceipt } from "../../src/serve/receipts";
import { catchUpSchedule, pickDueRail } from "../../src/serve/schedule-policy";
import { listSchedules } from "../../src/serve/schema";
import { emptyRunTotals } from "../../src/serve/types";

const HOUR = 3_600_000;
const idleSync = async () => ({ events_synced: 0, events_stored: 0, events_duplicate: 0, events_self_skipped: 0, errors: [] as string[] });
const storingSync = async () => ({ events_synced: 1, events_stored: 1, events_duplicate: 0, events_self_skipped: 0, errors: [] as string[] });

function withVault(run: (db: Database, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "kizuki-schedule-policy-"));
  initVault(root);
  const db = openLedger(join(root, ".kizuki", "kizuki.db"));
  return run(db, root).finally(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
}
const row = (db: Database, rail: string) => listSchedules(db).find(item => item.rail === rail)!;
const only = (db: Database, ...rails: string[]) =>
  db.query(`UPDATE schedules SET enabled = CASE WHEN rail IN (${rails.map(() => "?").join(",")}) THEN 1 ELSE 0 END`).run(...rails);

test("a rail 14 hours behind is back on real time after one scheduled run, on its own phase", () => withVault(async (db, root) => {
  only(db, "sync");
  const due = new Date(Date.now() - 14 * HOUR - 17_000).toISOString();
  db.query("UPDATE schedules SET next_run_at=? WHERE rail='sync'").run(due);
  const period = row(db, "sync").period_s * 1000;
  let ticks = 0;
  await runServeDaemon(db, root, { http: false, hooks: { sync: idleSync }, shouldContinue: () => ticks++ === 0 });
  const after = row(db, "sync");
  expect(after.last_run_at).not.toBeNull();
  const next = Date.parse(after.next_run_at!), finished = Date.parse(after.last_run_at!);
  // The first slot strictly after the finish, on the old grid.
  expect(next).toBeGreaterThan(finished);
  expect(next - finished).toBeLessThanOrEqual(period);
  expect((next - Date.parse(due)) % period).toBe(0);
  expect(dueRails(db, new Date().toISOString())).not.toContain("sync");
}));

test("catch-up keeps a fixed rail's phase and an hour-pinned rail's hour, and moves only the slot its run set", () => withVault(async (db, root) => {
  const due = "2026-09-01T00:00:10.000Z", finished = "2026-09-03T05:12:00.000Z";
  db.query("UPDATE schedules SET next_run_at=? WHERE rail IN ('embed-backfill','brief')").run(due);
  const scheduled = (rail: string, run_id: string) => ({ ...emptyRunTotals(), run_id, rail, started_at: finished, finished_at: finished,
    status: "ok" as const, stopped: null, execution: { instance_id: "i", pid: 1, boot_id: "b", trigger: "scheduled" as const, due_at: due } });
  persistRunReceipt(db, root, scheduled("embed-backfill", "run-embed"));
  const period = row(db, "embed-backfill").period_s * 1000;
  expect(catchUpSchedule(db, root, "embed-backfill", finished)).toBe(new Date(Date.parse(due) +
    (Math.floor((Date.parse(finished) - Date.parse(due)) / period) + 1) * period).toISOString());
  expect(Date.parse(row(db, "embed-backfill").next_run_at!)).toBeGreaterThan(Date.parse(finished));
  // A second call finds the slot already ahead and leaves it.
  expect(catchUpSchedule(db, root, "embed-backfill", finished)).toBeNull();

  persistRunReceipt(db, root, scheduled("brief", "run-brief"));
  const hour = loadServeConfig(root).brief_hour;
  expect(catchUpSchedule(db, root, "brief", finished)).toBe(nextScheduleSlot(finished, 86_400, hour));
  expect(new Date(row(db, "brief").next_run_at!).getUTCHours()).toBe(hour);

  // A slot some other run set (last_run_at differs) is not this run's to move.
  db.query("UPDATE schedules SET next_run_at=? WHERE rail='journal-prune'").run(due);
  expect(catchUpSchedule(db, root, "journal-prune", finished)).toBeNull();
  expect(row(db, "journal-prune").next_run_at).toBe(due);
}));

test("the fair pick takes the least recently run due rail, never-run first, ties in schedule order", () => withVault(async (db) => {
  db.query("UPDATE schedules SET last_run_at=NULL").run();
  expect(pickDueRail(db, ["retrieval-sweep", "sync"])).toBe("retrieval-sweep");
  db.query("UPDATE schedules SET last_run_at='2026-09-01T00:00:00.000Z' WHERE rail='retrieval-sweep'").run();
  expect(pickDueRail(db, ["retrieval-sweep", "sync"])).toBe("sync");
  db.query("UPDATE schedules SET last_run_at='2026-09-01T00:05:00.000Z' WHERE rail='sync'").run();
  expect(pickDueRail(db, ["retrieval-sweep", "sync"])).toBe("retrieval-sweep");
  expect(pickDueRail(db, [])).toBeUndefined();
}));

test("two rails that stay due alternate instead of the first one running every pass", () => withVault(async (db, root) => {
  only(db, "sync", "retrieval-sweep");
  const ran: string[] = [];
  let last = new Map<string, string | null>();
  let ticks = 0;
  await runServeDaemon(db, root, { http: false, hooks: { sync: idleSync }, shouldContinue: () => {
    const now = new Map(listSchedules(db).map(item => [item.rail, item.last_run_at]));
    for (const [rail, at] of now) if (at !== (last.get(rail) ?? null)) ran.push(rail);
    last = now;
    // Both rails are permanently due: each pass finds them in the past again.
    db.query("UPDATE schedules SET next_run_at='2026-01-01T00:00:00.000Z' WHERE rail IN ('sync','retrieval-sweep')").run();
    return ticks++ < 4;
  } });
  expect(ran).toEqual(["retrieval-sweep", "sync", "retrieval-sweep", "sync"]);
}));

test("a sync that stored events is followed by an index sweep before the next sync, and the sweep keeps its slot", () => withVault(async (db, root) => {
  only(db, "sync", "retrieval-sweep");
  const sweepSlot = new Date(Date.now() + HOUR).toISOString();
  db.query("UPDATE schedules SET next_run_at=? WHERE rail='retrieval-sweep'").run(sweepSlot);
  db.query("UPDATE schedules SET next_run_at=? WHERE rail='sync'").run(new Date(Date.now() - 1000).toISOString());
  let ticks = 0;
  await runServeDaemon(db, root, { http: false, hooks: { sync: storingSync }, shouldContinue: () => ticks++ === 0 });
  const runs = listRunReceipts(db).sort((a, b) => a.started_at.localeCompare(b.started_at));
  expect(runs.map(item => [item.rail, item.execution?.trigger])).toEqual([["sync", "scheduled"], ["retrieval-sweep", "once"]]);
  expect(runs[0]!.events_stored).toBe(1);
  expect(runs[1]!.schedule_transition).toBeUndefined();
  expect(row(db, "retrieval-sweep").next_run_at).toBe(sweepSlot);
  expect(Date.parse(row(db, "sync").next_run_at!)).toBeGreaterThan(Date.parse(runs[1]!.finished_at));
}));

test("a sync that stored nothing leaves the sweep to its own slot", () => withVault(async (db, root) => {
  only(db, "sync", "retrieval-sweep");
  db.query("UPDATE schedules SET next_run_at=? WHERE rail='retrieval-sweep'").run(new Date(Date.now() + HOUR).toISOString());
  db.query("UPDATE schedules SET next_run_at=? WHERE rail='sync'").run(new Date(Date.now() - 1000).toISOString());
  let ticks = 0;
  await runServeDaemon(db, root, { http: false, hooks: { sync: idleSync }, shouldContinue: () => ticks++ === 0 });
  expect(listRunReceipts(db).map(item => item.rail)).toEqual(["sync"]);
}));
