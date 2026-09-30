import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLedgerBusy } from "../../src/ledger/busy";
import { openLedger } from "../../src/ledger/db";
import {
  INGEST_LEASE,
  asLeaseHeld,
  ledgerLeaseHolder,
  railLeaseHeldNote,
} from "../../src/serve/lease-held";
import { acquireLease, pidAlive, readBootId } from "../../src/serve/leases";
import { railDoctor } from "../../src/serve/doctor-rails";
import { runServeDaemon } from "../../src/serve/daemon";
import { runRail } from "../../src/serve/rails";
import { requestServeStop } from "../../src/serve/stop-control";
import { persistRunReceipt, listRunReceipts, readRunReceiptsLog, readPendingRunReceipts } from "../../src/serve/receipts";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { listSchedules } from "../../src/serve/schema";
import {
  LEDGER_LEASE_HELD_STOP,
  emptyRunTotals,
  type RunReceipt,
} from "../../src/serve/types";
import { tempVault } from "../helpers/vault";

// These tests spawn real processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

const HOLDER = join(import.meta.dir, "../ledger-busy-child.ts");
const idleSync = async () => ({
  events_synced: 0,
  events_stored: 0,
  events_duplicate: 0,
  events_self_skipped: 0,
  errors: [] as string[],
});

function openVault(busyTimeoutMs?: number) {
  const vault = tempVault("ledger-held-");
  cleanup.push(vault.dispose);
  const dbPath = join(vault.path, ".kizuki", "kizuki.db");
  const db = openLedger(dbPath, busyTimeoutMs === undefined ? {} : { busyTimeoutMs });
  cleanup.push(() => db.close());
  return { vault: vault.path, db, dbPath };
}

/** A second process holding the SQLite write lock, as a long ingest between two of its commits does not. */
async function holdWriteLock(dbPath: string, holdMs: number) {
  const child = Bun.spawn([process.execPath, HOLDER, dbPath, String(holdMs)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("write-lock holder ended before it held");
    buffered += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return child;
}

/** A live process other than this one, recorded as the running ingest. */
function recordIngest(db: ReturnType<typeof openLedger>, pid: number): void {
  const process = {
    pid,
    boot_id: readBootId(),
    now: () => new Date().toISOString(),
    isAlive: pidAlive,
  };
  expect(acquireLease(db, process, INGEST_LEASE).acquired).toBe(true);
}

test("a pass skipped for a held ledger records the typed stop and the holder, and leaves the rail due", async () => {
  const { vault, db } = openVault();
  recordIngest(db, process.ppid);
  const due = listSchedules(db).find(
    (row) => row.rail === "retrieval-sweep",
  )!.next_run_at;
  const receipt = await runRail(db, vault, "retrieval-sweep", {
    ledgerHeld: true,
    now: () => new Date().toISOString(),
    execution: {
      instance_id: "i",
      pid: process.pid,
      boot_id: readBootId(),
      trigger: "scheduled",
      due_at: due ?? new Date().toISOString(),
    },
  });
  expect(receipt).toMatchObject({
    rail: "retrieval-sweep",
    status: "stopped",
    stopped: LEDGER_LEASE_HELD_STOP,
  });
  expect(receipt.errors).toEqual([
    `ledger:lease_held: a running kizuki ingest (pid ${process.ppid}) holds the ledger writer lease; this pass was skipped and the rail retries with backoff`,
  ]);
  expect(receipt.schedule_transition).toBeUndefined();
  expect(listRunReceipts(db).map((item) => [item.rail, item.stopped])).toEqual([
    ["retrieval-sweep", LEDGER_LEASE_HELD_STOP],
  ]);
  // The rail is still due: the daemon runs the pass again after its backoff.
  expect(
    listSchedules(db).find((row) => row.rail === "retrieval-sweep")!
      .next_run_at,
  ).toBe(due);
});

test("a rail whose write meets a writer it cannot outwait is skipped, not failed, and the next pass runs normally", async () => {
  // No wait: the held ledger is met at once instead of after the ordinary bound.
  const { vault, db, dbPath } = openVault(0);
  const holder = await holdWriteLock(dbPath, 20_000);
  // The pass is skipped; only publishing its receipt to the held ledger is refused.
  const refused = await runRail(db, vault, "sync", {
    hooks: { sync: idleSync },
  }).catch((error: unknown) => error);
  expect(isLedgerBusy(refused)).toBe(true);
  // Its journal line is durable, and says the pass was skipped rather than that anything broke.
  const [skipped] = readRunReceiptsLog(vault);
  expect(skipped).toMatchObject({
    rail: "sync",
    status: "stopped",
    stopped: LEDGER_LEASE_HELD_STOP,
  });
  expect(skipped!.errors[0]).toContain("this pass was skipped");
  expect(skipped!.errors.join()).not.toContain("database is locked");
  holder.kill();
  await holder.exited;
  const next = await runRail(db, vault, "sync", { hooks: { sync: idleSync } });
  expect(next).toMatchObject({ status: "ok", stopped: null });
  // The next pass replayed the skipped one into the ledger.
  expect(listRunReceipts(db).map((item) => item.stopped)).toContain(
    LEDGER_LEASE_HELD_STOP,
  );
});

test("the holder is the recorded ingest, else the daemon's marker, and never the caller itself", () => {
  const { vault, db } = openVault();
  expect(ledgerLeaseHolder(vault, db)).toBeNull();
  writeFileSync(
    join(vault, ".kizuki", "serve.pid"),
    `${JSON.stringify({ pid: process.ppid, boot_id: "b", instance_id: "i" })}\n`,
    { mode: 0o600 },
  );
  expect(ledgerLeaseHolder(vault, db)).toEqual({
    pid: process.ppid,
    kind: "daemon",
  });
  expect(ledgerLeaseHolder(vault, db, process.ppid)).toBeNull();
  recordIngest(db, process.ppid);
  expect(ledgerLeaseHolder(vault, db)).toEqual({
    pid: process.ppid,
    kind: "ingest",
  });
  expect(railLeaseHeldNote(vault, db)).toContain(
    `a running kizuki ingest (pid ${process.ppid})`,
  );
  // A recorded ingest whose process is gone names nobody.
  db.query("UPDATE leases SET holder_pid = 2147483646 WHERE name = ?").run(
    INGEST_LEASE,
  );
  expect(ledgerLeaseHolder(vault, db)).toEqual({
    pid: process.ppid,
    kind: "daemon",
  });
  expect(asLeaseHeld(vault, new Error("database is locked"), db)).toBeNull();
});

function skippedReceipt(index: number): RunReceipt {
  const at = new Date(
    Date.parse("2026-09-29T00:00:00Z") + index * 60_000,
  ).toISOString();
  return {
    ...emptyRunTotals(),
    run_id: `run-${index}`,
    rail: "sync",
    started_at: at,
    finished_at: at,
    status: "stopped",
    stopped: LEDGER_LEASE_HELD_STOP,
    errors: [
      "ledger:lease_held: a running kizuki ingest (pid 4242) holds the ledger writer lease; this pass was skipped and the rail retries with backoff",
    ],
  };
}

test("doctor names the holder once a rail keeps meeting a held ledger, and not before", () => {
  const { db } = openVault();
  const context = { db, model_configured: false, embedding_configured: false };
  const now = "2026-09-29T00:10:00Z";
  const four = [0, 1, 2, 3].map(skippedReceipt);
  expect(railDoctor("sync", four, 900, now, true, 0, context).status).toBe(
    "ok",
  );
  const five = [0, 1, 2, 3, 4].map(skippedReceipt);
  const down = railDoctor("sync", five, 900, now, true, 0, context);
  expect(down.status).toBe("down");
  expect(down.reason).toContain("a running kizuki ingest (pid 4242)");
  expect(down.reason).not.toContain("stopped ledger:lease_held");
});

test("the doctor report carries the holder in the failing rail's line", () => {
  const { vault, db } = openVault();
  const now = new Date().toISOString();
  for (let index = 0; index < 5; index += 1) {
    const at = new Date(Date.parse(now) - (5 - index) * 1_000).toISOString();
    persistRunReceipt(db, vault, {
      ...skippedReceipt(index),
      run_id: `01JLEDGERHELD00000000000${index}`,
      started_at: at,
      finished_at: at,
    });
  }
  const report = inspectServeDoctor(db, vault, { now, host_checks: false, page_walk: false });
  const line = report.failures.find((failure) => failure.startsWith("rail sync:"));
  expect(line).toContain("last 5 runs ended stopped");
  expect(line).toContain("a running kizuki ingest (pid 4242)");
  expect(report.top_failure).toEqual({ kind: "rail", rail: "sync" });
});

test("doctor diagnoses pending skipped receipts while the writer still holds the ledger, without counting duplicates or malformed lines", async () => {
  const { vault, db, dbPath } = openVault(0);
  const now = new Date().toISOString();
  const receipt = (index: number): RunReceipt => ({
    ...skippedReceipt(index),
    started_at: new Date(Date.parse(now) - (5 - index) * 1_000).toISOString(),
    finished_at: new Date(Date.parse(now) - (5 - index) * 1_000).toISOString(),
  });
  persistRunReceipt(db, vault, receipt(0));
  recordIngest(db, process.ppid);
  const holder = await holdWriteLock(dbPath, 100_000);
  for (let index = 1; index < 5; index++) {
    await expect(runRail(db, vault, "sync", { ledgerHeld: true })).rejects.toBeDefined();
  }
  const journal = join(vault, ".kizuki", "run-receipts.jsonl");
  // Duplicate pending and persisted ids must not lengthen the failure streak.
  const pending = readRunReceiptsLog(vault).at(-1)!;
  appendFileSync(journal, JSON.stringify(pending) + "\n" + JSON.stringify(receipt(0)) + "\n");
  appendFileSync(journal, JSON.stringify({ ...receipt(98), schedule_transition: {} }) + '\nnot-json\n' +
    JSON.stringify({ ...receipt(99), started_at: "bad", finished_at: "bad" }) + "\n");
  const report = inspectServeDoctor(db, vault, { host_checks: false, page_walk: false });
  expect(readPendingRunReceipts(db, vault)).toHaveLength(4);
  const rail = report.rails.find(item => item.rail === "sync")!;
  expect(rail.status).toBe("down");
  expect(rail.reason).toContain("last 5 runs ended stopped");
  expect(rail.reason).toContain("holds the ledger writer lease");
  expect(rail.reason).toContain(`a running kizuki ingest (pid ${process.ppid})`);
  expect(listRunReceipts(db)).toHaveLength(1);
  expect(holder.exitCode).toBeNull();
  holder.kill("SIGKILL");
  await holder.exited;
});

test("the daemon survives a writer that holds the ledger past every wait, journals its skipped passes, and resumes when it lets go", async () => {
  const { vault, db, dbPath } = openVault();
  recordIngest(db, process.ppid);
  const lines: string[] = [];
  let running = true;
  const daemon = runServeDaemon(db, vault, {
    http: false,
    hooks: { sync: idleSync },
    log: (line) => lines.push(line),
    shouldContinue: () => running,
    // Backoffs are real decisions but need not be real waiting.
    sleep: (ms) => Bun.sleep(Math.min(ms, 40)),
  });
  let settled: "resolved" | "rejected" | null = null;
  daemon.then(
    () => {
      settled = "resolved";
    },
    () => {
      settled = "rejected";
    },
  );
  const until = async (what: string, probe: () => boolean): Promise<void> => {
    const deadline = Date.now() + 40_000;
    while (!probe()) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(25);
    }
  };
  await until(
    "the first pass of every rail",
    () => listRunReceipts(db).length >= 7,
  );
  db.query("UPDATE schedules SET next_run_at = ?").run(
    new Date(Date.now() + 5_000).toISOString(),
  );
  const holder = await holdWriteLock(dbPath, 12_000);
  await until("a skipped pass in the journal", () =>
    readRunReceiptsLog(vault).some(
      (item) => item.stopped === LEDGER_LEASE_HELD_STOP,
    ),
  );
  expect(settled).toBeNull();
  await holder.exited;
  await until(
    "the skipped passes in the ledger and every rail current",
    () =>
      listRunReceipts(db).some(
        (item) => item.stopped === LEDGER_LEASE_HELD_STOP,
      ) &&
      listSchedules(db).every(
        (row) =>
          row.next_run_at !== null &&
          row.next_run_at > new Date().toISOString(),
      ),
  );
  expect(settled).toBeNull();
  const events = lines.map(
    (line) => (JSON.parse(line) as { event: string }).event,
  );
  expect(events).toEqual(["ledger_held", "ledger_free"]);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    holder: "ingest",
    holder_pid: process.ppid,
  });
  running = false;
  await daemon;
  expect(existsSync(join(vault, ".kizuki", "serve.pid"))).toBe(false);
});

test("a stop request ends the daemon during a long backoff instead of after it", async () => {
  const { vault, db, dbPath } = openVault(1_000);
  const lines: string[] = [];
  const daemon = runServeDaemon(db, vault, { http: false, hooks: { sync: idleSync }, log: line => lines.push(line) });
  const until = async (probe: () => boolean): Promise<void> => {
    const deadline = Date.now() + 40_000;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(25);
    }
  };
  await until(() => listRunReceipts(db).length >= 7);
  const holder = await holdWriteLock(dbPath, 60_000);
  await until(() => lines.some(line => line.includes("ledger_held")));
  // Let the backoff grow past what the test is willing to wait for.
  await Bun.sleep(1_500);
  const started = Date.now();
  await requestServeStop(vault);
  await daemon;
  expect(Date.now() - started).toBeLessThan(5_000);
  holder.kill();
  await holder.exited;
});
