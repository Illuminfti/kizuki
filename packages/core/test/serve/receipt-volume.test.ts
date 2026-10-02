import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { runServeDaemon } from "../../src/serve/daemon";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { runRail } from "../../src/serve/rails";
import { listRunReceipts, orphanJournalReceipts, persistRunReceipt, pruneRunReceipts, recoverRunJournal, runReceiptsPath } from "../../src/serve/receipts";
import { listSchedules } from "../../src/serve/schema";
import { writeServeIntent } from "../../src/serve/intent";
import type { SupervisorHost } from "../../src/serve/supervisor";
import { DOCTOR_JOURNAL_TAIL_BYTES, DOCTOR_RECEIPT_LIMIT, EMBED_BACKFILL_IDLE_PERIOD_S, emptyRunTotals, type RailId, type RunExecution } from "../../src/serve/types";

const dirs: string[] = [];

function vault(serveToml?: string) {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-receipt-volume-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  if (serveToml !== undefined) writeFileSync(join(path, ".kizuki", "serve.toml"), serveToml);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  // Fresh schedules are due at the epoch; anchor them so slot arithmetic is readable.
  db.query("UPDATE schedules SET next_run_at = ?").run("2026-09-10T00:00:00.000Z");
  return { path, db };
}

const supervisor: SupervisorHost = {
  kind: "systemd", home: "/tmp", execStart: "kizuki serve",
  query: () => ({ kind: "systemd", state: "active", enabled: true, unit: "synthetic", detail: "active" }),
  reload: () => ({ ok: true, detail: "ok" }), enable: () => ({ ok: true, detail: "ok" }), disable: () => ({ ok: true, detail: "ok" }),
};

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const at = (offsetSeconds: number) => new Date(Date.parse("2026-09-10T00:00:00.000Z") + offsetSeconds * 1000).toISOString();
const schedule = (db: ReturnType<typeof vault>["db"], rail: string) => listSchedules(db).find((row) => row.rail === rail)!;
const journalLines = (path: string) => readFileSync(runReceiptsPath(path), "utf8").split("\n").filter((line) => line.length > 0);

/** One scheduled tick of `rail`, due at its stored slot. */
function tick(db: ReturnType<typeof vault>["db"], path: string, rail: RailId, now: string) {
  const execution: RunExecution = { instance_id: "instance", pid: process.pid, boot_id: "boot", trigger: "scheduled", due_at: schedule(db, rail).next_run_at };
  return runRail(db, path, rail, { now: () => now, execution });
}

describe("embed-backfill without an embedding port", () => {
  test("backs off to a long period and pulls forward when a port is configured", async () => {
    const { path, db } = vault();
    expect(schedule(db, "embed-backfill").period_s).toBe(60);
    await tick(db, path, "embed-backfill", at(0));
    expect(schedule(db, "embed-backfill")).toMatchObject({
      period_s: EMBED_BACKFILL_IDLE_PERIOD_S,
      next_run_at: at(EMBED_BACKFILL_IDLE_PERIOD_S),
    });
    writeFileSync(join(path, ".kizuki", "serve.toml"), '[ports]\nembedding = "kizuki.embedding.gguf"\n');
    await tick(db, path, "embed-backfill", at(EMBED_BACKFILL_IDLE_PERIOD_S));
    expect(schedule(db, "embed-backfill").period_s).toBe(60);
    expect(schedule(db, "embed-backfill").next_run_at).toBe(at(EMBED_BACKFILL_IDLE_PERIOD_S + 60));
    db.close();
  });

  test("an embedding id the host cannot bind is invalid and keeps the long period", async () => {
    const { path, db } = vault('[ports]\nembedding = "kizuki.embedding.typo"\n');
    await tick(db, path, "embed-backfill", at(0));
    expect(schedule(db, "embed-backfill").period_s).toBe(EMBED_BACKFILL_IDLE_PERIOD_S);
    writeServeIntent(path, "installed");
    const report = inspectServeDoctor(db, path, { now: at(60), supervisor });
    expect(report.stores.vector_layer).toEqual({ state: "invalid", detail: "vector layer: invalid (unknown embedding port)" });
    expect(JSON.stringify(report)).not.toContain("typo");
    db.close();
  });

  test("a corrupt serve.toml is invalid, not off", () => {
    const { path, db } = vault("[ports\nembedding =");
    expect(inspectServeDoctor(db, path, { now: at(60), supervisor }).stores.vector_layer.state).toBe("invalid");
    db.close();
  });

  test("a configured port keeps the short period", async () => {
    const { path, db } = vault('[ports.embedding]\nid = "kizuki.embedding.gguf"\n');
    await tick(db, path, "embed-backfill", at(0));
    expect(schedule(db, "embed-backfill")).toMatchObject({ period_s: 60, next_run_at: at(60) });
    db.close();
  });

  test("the daemon applies the back-off at start, so the first tick is not a minute away", async () => {
    const { path, db } = vault();
    await runServeDaemon(db, path, { http: false, shouldContinue: () => false });
    expect(schedule(db, "embed-backfill").period_s).toBe(EMBED_BACKFILL_IDLE_PERIOD_S);
    db.close();
  });

  test("doctor says the vector layer is off and keeps an idle embed rail healthy", () => {
    const { path, db } = vault();
    for (let index = 0; index < 8; index += 1) {
      persistRunReceipt(db, path, {
        ...emptyRunTotals(), run_id: `01JEMBEDIDLE000000000000${index}`, rail: "embed-backfill",
        started_at: at(index * 3600), finished_at: at(index * 3600 + 1), status: "ok", stopped: null,
      });
    }
    writeServeIntent(path, "installed");
    const report = inspectServeDoctor(db, path, { now: at(7 * 3600 + 60), supervisor });
    expect(report.stores.vector_layer).toEqual({ state: "off", detail: "vector layer: off (no embedding model configured)" });
    expect(report.rails.find((rail) => rail.rail === "embed-backfill")).toMatchObject({ status: "ok", reason: null });
    db.close();
  });

  test("doctor reports a configured port and keeps a quiet embed rail with nothing to embed healthy", () => {
    const { path, db } = vault('[ports]\nembedding = "kizuki.embedding.gguf"\n');
    for (let index = 0; index < 6; index += 1) {
      persistRunReceipt(db, path, {
        ...emptyRunTotals(), run_id: `01JEMBEDPORT000000000000${index}`, rail: "embed-backfill",
        started_at: at(index * 60), finished_at: at(index * 60 + 1), status: "ok", stopped: null,
      });
    }
    writeServeIntent(path, "installed");
    const report = inspectServeDoctor(db, path, { now: at(6 * 60), supervisor });
    expect(report.stores.vector_layer).toEqual({ state: "configured", detail: "vector layer: configured (kizuki.embedding.gguf)" });
    expect(report.rails.find((rail) => rail.rail === "embed-backfill")).toMatchObject({ status: "ok", reason: null, empty_streak: 0 });
    db.close();
  });

  test("a configured port that reports a backlog it cannot embed is down with the reason", () => {
    const { path, db } = vault('[ports]\nembedding = "kizuki.embedding.gguf"\n');
    for (let index = 0; index < 6; index += 1) {
      persistRunReceipt(db, path, {
        ...emptyRunTotals(), run_id: `01JEMBEDDOWN000000000000${index}`, rail: "embed-backfill",
        started_at: at(index * 60), finished_at: at(index * 60 + 1), status: "degraded", stopped: null,
        retrieval: { upserts: 0, removals: 0, pending_ops: 4, degraded: ["embedding-unavailable"] },
      });
    }
    writeServeIntent(path, "installed");
    const rail = inspectServeDoctor(db, path, { now: at(6 * 60), supervisor }).rails.find((item) => item.rail === "embed-backfill")!;
    expect(rail.status).toBe("down");
    expect(rail.reason).toContain("embedding-unavailable");
    db.close();
  });

  test("coalesced idle runs of a configured embed rail with nothing to embed stay healthy", async () => {
    const { path, db } = vault('[ports]\nembedding = "kizuki.embedding.gguf"\n');
    for (let minute = 0; minute <= 6; minute += 1) await tick(db, path, "embed-backfill", at(minute * 60));
    expect(listRunReceipts(db, { rail: "embed-backfill" })).toHaveLength(1);
    writeServeIntent(path, "installed");
    const rail = inspectServeDoctor(db, path, { now: at(6 * 60 + 1), supervisor }).rails.find((item) => item.rail === "embed-backfill")!;
    expect(rail).toMatchObject({ status: "ok", reason: null, empty_streak: 0 });
    db.close();
  });
});

describe("no-op runs do not append a receipt per tick", () => {
  test("a scheduled idle rail writes one receipt, advances its schedule, then heartbeats hourly", async () => {
    const { path, db } = vault();
    await tick(db, path, "purge-sweep", at(0));
    expect(listRunReceipts(db, { rail: "purge-sweep" })).toHaveLength(1);
    for (let minutes = 10; minutes < 60; minutes += 10) await tick(db, path, "purge-sweep", at(minutes * 60));
    expect(listRunReceipts(db, { rail: "purge-sweep" })).toHaveLength(1);
    expect(schedule(db, "purge-sweep")).toMatchObject({ last_run_at: at(50 * 60), next_run_at: at(60 * 60) });
    await tick(db, path, "purge-sweep", at(60 * 60));
    expect(listRunReceipts(db, { rail: "purge-sweep" })).toHaveLength(2);
    expect(journalLines(path).filter((line) => line.includes('"purge-sweep"'))).toHaveLength(2);
    db.close();
  });

  test("the daemon counts persisted receipts, not coalesced runs", async () => {
    const { path, db } = vault();
    let turns = 0;
    const result = await runServeDaemon(db, path, { http: false, shouldContinue: () => (turns += 1) <= 25 });
    const persisted = listRunReceipts(db).length;
    expect(result.receipts).toBe(persisted);
    expect(persisted).toBeLessThan(25);
    db.close();
  }, 30_000);

  test("manual runs and the brief always write their receipt", async () => {
    const { path, db } = vault();
    await runRail(db, path, "purge-sweep", { now: () => at(0) });
    await runRail(db, path, "purge-sweep", { now: () => at(60) });
    expect(listRunReceipts(db, { rail: "purge-sweep" })).toHaveLength(2);
    await tick(db, path, "brief", at(0));
    await tick(db, path, "brief", at(600));
    expect(listRunReceipts(db, { rail: "brief" })).toHaveLength(2);
    db.close();
  });

  test("a run that did something after idle ticks is receipted", async () => {
    const { path, db } = vault();
    await tick(db, path, "retrieval-sweep", at(0));
    await tick(db, path, "retrieval-sweep", at(300));
    expect(listRunReceipts(db, { rail: "retrieval-sweep" })).toHaveLength(1);
    db.query(
      `INSERT INTO retrieval_ops (op_id, store, op, doc_id, state, created_at)
       VALUES ('op-1', 'store', 'upsert', 'doc-1', 'pending', ?)`,
    ).run(at(310));
    await tick(db, path, "retrieval-sweep", at(600));
    expect(listRunReceipts(db, { rail: "retrieval-sweep" }).length).toBeGreaterThan(1);
    db.close();
  });

  test("doctor sees a coalesced idle rail as alive", async () => {
    const { path, db } = vault();
    await tick(db, path, "purge-sweep", at(0));
    for (let minutes = 10; minutes <= 50; minutes += 10) await tick(db, path, "purge-sweep", at(minutes * 60));
    writeServeIntent(path, "installed");
    const rail = inspectServeDoctor(db, path, { now: at(51 * 60), supervisor }).rails.find((item) => item.rail === "purge-sweep")!;
    expect(rail.age_s).toBe(60);
    expect(rail.last_receipt_at).toBe(at(0));
    db.close();
  });
});

describe("receipt journal bounds", () => {
  function seed(path: string, db: ReturnType<typeof vault>["db"], count: number, pad = "") {
    for (let index = 0; index < count; index += 1) {
      persistRunReceipt(db, path, {
        ...emptyRunTotals(), run_id: `01JBOUNDS${String(index).padStart(17, "0")}`, rail: "test-rail",
        started_at: at(index), finished_at: at(index), status: "ok", stopped: null, errors: pad === "" ? [] : [pad],
      });
    }
  }

  test("journal-prune drops receipts older than the retention window", () => {
    const { path, db } = vault();
    seed(path, db, 10);
    const result = pruneRunReceipts(db, path, at(6));
    expect(result).toEqual({ deleted: 6, rewritten: 0 });
    expect(journalLines(path)).toHaveLength(0);
    expect(listRunReceipts(db).map((item) => item.finished_at)).toEqual([at(6), at(7), at(8), at(9)]);
    db.close();
  });

  test("journal-prune retires a replayed journal over the size ceiling and retains SQL audit history", () => {
    const { path, db } = vault();
    seed(path, db, 40, "x".repeat(200));
    const lineBytes = Buffer.byteLength(journalLines(path)[0]!) + 1;
    const result = pruneRunReceipts(db, path, at(-1), lineBytes * 10 + 5);
    expect(result).toEqual({ deleted: 0, rewritten: 0 });
    expect(statSync(runReceiptsPath(path)).size).toBeLessThanOrEqual(lineBytes * 10 + 5);
    const remaining = listRunReceipts(db);
    expect(remaining).toHaveLength(40);
    expect(remaining[0]!.finished_at).toBe(at(0));
    expect(journalLines(path)).toEqual([]);
    db.close();
  });

  test("the journal-prune rail applies the size ceiling and keeps the newest receipt", async () => {
    const { path, db } = vault();
    const pad = "x".repeat(800_000);
    const insert = db.query("INSERT INTO run_receipts (run_id, rail, started_at, finished_at, status, stopped, report) VALUES (?, 'test-rail', ?, ?, 'ok', NULL, ?)");
    for (let index = 0; index < 12; index += 1) {
      const report = JSON.stringify({ ...emptyRunTotals(), run_id: `01JBIG${String(index).padStart(20, "0")}`, rail: "test-rail", started_at: at(index), finished_at: at(index), status: "ok", stopped: null, errors: [pad] });
      insert.run(`01JBIG${String(index).padStart(20, "0")}`, at(index), at(index), report);
      appendFileSync(runReceiptsPath(path), `${report}\n`);
    }
    expect(statSync(runReceiptsPath(path)).size).toBeGreaterThan(9 * 1024 * 1024);
    const receipt = await runRail(db, path, "journal-prune", { now: () => at(1000) });
    expect(receipt.status).toBe("ok");
    // The size ceiling, plus the prune rail's own receipt appended after it.
    expect(statSync(runReceiptsPath(path)).size).toBeLessThan(8 * 1024 * 1024 + 4096);
    const remaining = listRunReceipts(db, { rail: "test-rail" });
    expect(remaining).toHaveLength(12);
    expect(remaining.at(-1)!.run_id).toBe("01JBIG00000000000000000011");
    expect(journalLines(path).filter((line) => line.includes("test-rail"))).toHaveLength(0);
    expect(listRunReceipts(db, { rail: "journal-prune" })).toHaveLength(1);
    db.close();
  });

  test("an oversized recovery journal does not shorten SQL retention", () => {
    const { path, db } = vault();
    seed(path, db, 3, "x".repeat(200));
    const result = pruneRunReceipts(db, path, at(-1), 10);
    expect(result).toEqual({ deleted: 0, rewritten: 0 });
    expect(listRunReceipts(db).map((item) => item.finished_at)).toEqual([at(0), at(1), at(2)]);
    expect(journalLines(path)).toHaveLength(0);
    db.close();
  });

  test("an unreadable persisted receipt prevents journal retirement", () => {
    const { path, db } = vault();
    seed(path, db, 3);
    db.query("UPDATE run_receipts SET report = 'not json' WHERE finished_at >= ?").run(at(1));
    expect(() => pruneRunReceipts(db, path, at(1))).toThrow("invalid existing run receipt");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_receipts").get()!.n).toBe(3);
    expect(journalLines(path)).toHaveLength(3);
    db.close();
  });

  test("a journal that lost its oldest lines before the rows were deleted replays without error", () => {
    const { path, db } = vault();
    seed(path, db, 10);
    const lines = journalLines(path);
    writeFileSync(runReceiptsPath(path), lines.slice(6).map((line) => `${line}\n`).join(""));
    expect(recoverRunJournal(db, path)).toEqual([]);
    expect(listRunReceipts(db)).toHaveLength(10);
    pruneRunReceipts(db, path, at(6));
    expect(existsSync(`${runReceiptsPath(path)}.tmp`)).toBe(false);
    db.close();
  });

  test("doctor scans only the journal tail for orphans", () => {
    const { path, db } = vault();
    const orphan = (id: string) => JSON.stringify({ ...emptyRunTotals(), run_id: id, rail: "test-rail", started_at: at(0), finished_at: at(0), status: "ok", stopped: null });
    const filler = `${"x".repeat(1000)}\n`.repeat(Math.ceil(DOCTOR_JOURNAL_TAIL_BYTES / 1000) + 50);
    writeFileSync(runReceiptsPath(path), `${orphan("01JORPHANOLD00000000000000")}\n${filler}${orphan("01JORPHANNEW00000000000000")}\n`);
    expect(orphanJournalReceipts(db, path)).toEqual(["01JORPHANNEW00000000000000"]);
    db.close();
  });

  test("doctor reads at most the newest DOCTOR_RECEIPT_LIMIT receipts", () => {
    const { path, db } = vault();
    persistRunReceipt(db, path, {
      ...emptyRunTotals(), run_id: "01JOLDEST0000000000000000A", rail: "test-rail",
      started_at: at(0), finished_at: at(0), status: "ok", stopped: null, records_skipped: 7,
    });
    db.transaction(() => {
      for (let index = 1; index <= DOCTOR_RECEIPT_LIMIT; index += 1) {
        persistRunReceipt(db, path, {
          ...emptyRunTotals(), run_id: `01JNEWER${String(index).padStart(18, "0")}`, rail: "test-rail",
          started_at: at(index), finished_at: at(index), status: "ok", stopped: null,
        });
      }
    })();
    expect(inspectServeDoctor(db, path, { now: at(DOCTOR_RECEIPT_LIMIT + 60) }).throughput.records_skipped).toBe(0);
    db.close();
  });
});
