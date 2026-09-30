import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { runServeDaemon } from "../../src/serve/daemon";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { readLease } from "../../src/serve/leases";
import { evaluateQualification, type QualificationProfile } from "../../src/serve/qualification";
import {
  defineRail,
  isRailId,
  listRails,
  registerRail,
  renderRailsTable,
  type RailDefinition,
} from "../../src/serve/rail-registry";
import { dueRails, runRail, runServeOnce } from "../../src/serve/rails";
import { listRunReceipts, persistRunReceipt, readRunReceiptsLog, recoverRunJournal } from "../../src/serve/receipts";
import { listSchedules, seedSchedules } from "../../src/serve/schema";
import { writeServeIntent } from "../../src/serve/intent";
import type { SupervisorHost } from "../../src/serve/supervisor";
import { InjectedCrash, ServeDaemonError, WRITER_LEASE, emptyRunTotals, type RunReceipt } from "../../src/serve/types";
import { DEFAULT_RAILS, RAIL_IDS } from "../../src/serve/rail-registry";

// Some of these tests start a real process; bound them for a loaded host.
setDefaultTimeout(60_000);

const DOC = join(import.meta.dir, "../../../../docs/world/f5.md");
const dirs: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function vault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-rail-registry-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  disposers.push(() => db.close());
  return { path, db };
}

const definition = (overrides: Record<string, unknown> = {}): RailDefinition => defineRail({
  id: "fixture-rail",
  summary: "Fixture rail.",
  period_s: 300,
  jitter_s: 0,
  expects_output: false,
  run: () => ({ status: "ok", events_synced: 1 }),
  ...overrides,
} as RailDefinition);

function register(overrides: Record<string, unknown> = {}): RailDefinition {
  const rail = definition(overrides);
  disposers.push(registerRail(rail));
  return rail;
}

describe("the registry", () => {
  test("the shipped rails keep the schedule they had before the registry", () => {
    expect(DEFAULT_RAILS).toEqual([
      { rail: "sync", period_s: 900, jitter_s: 90, enabled: true },
      { rail: "retrieval-sweep", period_s: 300, jitter_s: 0, enabled: true },
      { rail: "purge-sweep", period_s: 600, jitter_s: 0, enabled: true },
      { rail: "embed-backfill", period_s: 60, jitter_s: 0, enabled: true },
      { rail: "brief", period_s: 86_400, jitter_s: 0, enabled: true },
      { rail: "doctor-sweep", period_s: 3_600, jitter_s: 0, enabled: true },
      { rail: "journal-prune", period_s: 86_400, jitter_s: 0, enabled: true },
    ]);
    expect([...RAIL_IDS]).toEqual(DEFAULT_RAILS.map((spec) => spec.rail));
    expect(listRails().map((rail) => rail.id)).toEqual([...RAIL_IDS]);
  });

  test("the ledger layer seeds every registered definition", () => {
    register();
    const { db } = vault();
    expect(listSchedules(db).map((row) => row.rail).sort()).toEqual([...RAIL_IDS].sort());
  });

  test("defineRail refuses ids and schedules the loop could not use", () => {
    for (const id of ["", "Sync", "-a", "a-", "a--b", "a b", "a".repeat(49)]) expect(() => definition({ id })).toThrow("invalid rail id");
    for (const period_s of [0, -60, 1.5, Number.NaN]) expect(() => definition({ period_s })).toThrow("period_s");
    for (const jitter_s of [-1, 300, 1.5]) expect(() => definition({ jitter_s })).toThrow("jitter_s");
    expect(() => definition({ idle_period_s: 300 })).toThrow("idle_period_s");
    expect(Object.isFrozen(definition())).toBe(true);
  });

  test("a runtime registration is visible until its remover runs, and ids never collide", () => {
    const rail = definition();
    const remove = registerRail(rail);
    expect(isRailId("fixture-rail")).toBe(true);
    expect(listRails().at(-1)).toBe(rail);
    expect(() => registerRail(definition())).toThrow("duplicate rail id");
    expect(() => registerRail(definition({ id: "sync" }))).toThrow("duplicate rail id");
    remove();
    remove();
    expect(isRailId("fixture-rail")).toBe(false);
    expect(RAIL_IDS).not.toContain("fixture-rail");
  });

  test("schedule seeding and the due list follow the registry", () => {
    const { db } = vault();
    expect(listSchedules(db).map((row) => row.rail)).not.toContain("fixture-rail");
    register();
    seedSchedules(db);
    expect(listSchedules(db).map((row) => row.rail)).toContain("fixture-rail");
    const row = listSchedules(db).find((item) => item.rail === "fixture-rail");
    expect(row).toMatchObject({ period_s: 300, jitter_s: 0, enabled: true });
    expect(dueRails(db, "2026-10-01T00:00:00Z")).toContain("fixture-rail");
    db.query("UPDATE schedules SET enabled = 0 WHERE rail = 'fixture-rail'").run();
    expect(dueRails(db, "2026-10-01T00:00:00Z")).not.toContain("fixture-rail");
  });

  test("qualification requires every registered rail in its profile", () => {
    const start = Date.parse("2026-09-05T00:00:00.000Z");
    const rails = () => listRails().map((rail) => ({ rail: rail.id, period_s: rail.period_s, jitter_s: rail.jitter_s, next_run_at: new Date(start).toISOString() }));
    const profile = (): QualificationProfile => ({ scope: "fixture", start_at: new Date(start).toISOString(), boot_id: "boot", monotonic_ms: 0,
      rails: rails(), brief_hour: 7, timezone: "UTC", supervisor: "none", sampling_interval_ms: 30_000, max_gap_ms: 60_000, lateness_ms: 30_000 });
    expect(evaluateQualification(profile(), []).issues).not.toContain("required-rails-missing");
    const shipped = profile();
    register();
    expect(evaluateQualification(shipped, []).issues).toContain("required-rails-missing");
    expect(evaluateQualification(profile(), []).issues).not.toContain("required-rails-missing");
  });
});

describe("running a registered rail", () => {
  test("writes a run receipt on success and on a thrown error", async () => {
    const { path, db } = vault();
    register();
    register({ id: "fixture-boom", run: () => { throw new Error("fixture rail exploded"); } });
    const ok = await runRail(db, path, "fixture-rail");
    const failed = await runRail(db, path, "fixture-boom");
    expect([ok.status, ok.events_synced]).toEqual(["ok", 1]);
    expect([failed.status, failed.errors]).toEqual(["failed", ["fixture rail exploded"]]);
    expect(readLease(db, WRITER_LEASE)).toBeNull();
    expect(listRunReceipts(db).map((receipt) => [receipt.rail, receipt.status])).toEqual([["fixture-rail", "ok"], ["fixture-boom", "failed"]]);
    expect(readRunReceiptsLog(path).map((receipt) => receipt.run_id)).toEqual([ok.run_id, failed.run_id]);
  });

  test("refuses a rail nothing registered, before it writes anything", async () => {
    const { path, db } = vault();
    const error = await runRail(db, path, "fixture-rail").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServeDaemonError);
    expect((error as ServeDaemonError).code).toBe("unknown_rail");
    expect(listRunReceipts(db)).toEqual([]);
  });

  test("a one-shot pass runs a rail registered after the vault opened", async () => {
    const { path, db } = vault();
    register();
    const receipts = await runServeOnce(db, path, { now: () => "2026-10-01T00:00:00Z" });
    expect(receipts.map((receipt) => receipt.rail)).toContain("fixture-rail");
    expect(receipts).toHaveLength(8);
  });

  test("a one-shot pass skips a disabled rail", async () => {
    const { path, db } = vault();
    register();
    seedSchedules(db);
    db.query("UPDATE schedules SET enabled = 0 WHERE rail = 'fixture-rail'").run();
    const receipts = await runServeOnce(db, path, { now: () => "2026-10-01T00:00:00Z" });
    expect(receipts.map((receipt) => receipt.rail)).not.toContain("fixture-rail");
    expect(receipts).toHaveLength(7);
  });

  test("runs under the daemon's writer lease and leaves it released", async () => {
    const { path, db } = vault();
    let holder: number | undefined;
    register({ run: () => { holder = readLease(db, WRITER_LEASE)?.holder_pid; return { status: "ok" }; } });
    const result = await runServeDaemon(db, path, { once: true, http: false, rails: ["fixture-rail"] });
    expect(result.receipts).toBe(1);
    expect(holder).toBe(process.pid);
    expect(readLease(db, WRITER_LEASE)).toBeNull();
  });

  test("a denied overlapping run leaves the active scheduled slot unchanged", async () => {
    const { path, db } = vault();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const artifactPath = join(path, "notes", "fixture-artifact.md");
    register({ artifact: () => artifactPath, run: async () => { await waiting; return { status: "ok", events_synced: 1 }; } });
    seedSchedules(db);
    const due = "2026-10-01T00:00:00.000Z";
    db.query("UPDATE schedules SET next_run_at=? WHERE rail='fixture-rail'").run(due);
    const before = listSchedules(db).find(row => row.rail === "fixture-rail");
    const active = runRail(db, path, "fixture-rail", {
      now: () => due,
      execution: { instance_id: "fixture-instance", pid: process.pid, boot_id: "fixture-boot", trigger: "scheduled", due_at: due },
    }).then(receipt => ({ receipt, error: undefined }), error => ({ receipt: undefined, error }));
    try {
      const denied = await runRail(db, path, "fixture-rail", { now: () => due });
      expect(denied.status).toBe("failed");
      expect(denied.schedule_transition).toBeUndefined();
      expect(listSchedules(db).find(row => row.rail === "fixture-rail")).toEqual(before);
      expect(existsSync(artifactPath)).toBe(false);
    } finally { release(); await active; }
    const result = await active;
    expect(result.error).toBeUndefined();
    expect(result.receipt?.status).toBe("ok");
    expect(listSchedules(db).find(row => row.rail === "fixture-rail")?.next_run_at)
      .toBe("2026-10-01T00:05:00.000Z");
  });

  test("work is bounded by the shared budget: an exhausted budget stops the run", async () => {
    const { path, db } = vault();
    writeFileSync(join(path, ".kizuki", "serve.toml"), "[budget]\ncanon_writes_per_run = 1\n");
    const spent: string[] = [];
    register({
      run: (context: { budget: { chargeWrite(write: unknown): void }; started_at: string }) => {
        for (const name of ["one", "two", "three"]) {
          context.budget.chargeWrite({ receipt_id: `fixture-${name}`, page_path: `notes/${name}.md`, before_hash: null, at: context.started_at });
          spent.push(name);
        }
        return { status: "ok" };
      },
    });
    const receipt = await runRail(db, path, "fixture-rail");
    expect(spent).toEqual(["one"]);
    expect(receipt).toMatchObject({ status: "stopped", stopped: "budget:canon_writes_per_run" });
    expect(receipt.budget["canon_writes_per_run"]).toEqual({ used: 1, limit: 1 });
  });
});

const ACTIVE = { kind: "systemd", state: "active", unit: "kizuki@x.service", enabled: true, detail: "active" } as const;
const host: SupervisorHost = {
  kind: "systemd", home: "/tmp", execStart: "kizuki serve", query: () => ACTIVE,
  reload: () => ({ ok: true, detail: "ok" }), enable: () => ({ ok: true, detail: "ok" }), disable: () => ({ ok: true, detail: "ok" }),
};
const minute = (n: number): string => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 60_000).toISOString();
let serial = 0;
function receipt(rail: string, n: number, overrides: Partial<RunReceipt> = {}): RunReceipt {
  serial += 1;
  return { ...emptyRunTotals(), run_id: `01JRAILREG${String(serial).padStart(16, "0")}`, rail, started_at: minute(n), finished_at: minute(n),
    status: "ok", stopped: null, ...overrides };
}

describe("doctor and a registered rail", () => {
  const railOf = (report: ReturnType<typeof inspectServeDoctor>, id: string) => {
    const found = report.rails.find((item) => item.rail === id);
    if (found === undefined) throw new Error(`missing rail ${id}`);
    return found;
  };
  const doctor = (path: string, db: ReturnType<typeof vault>["db"], now: string) => {
    writeServeIntent(path, "installed");
    return inspectServeDoctor(db, path, { now, supervisor: host });
  };

  test("lists the rail with its schedule, and judges it by staleness and failure", () => {
    register();
    const { path, db } = vault();
    expect(railOf(doctor(path, db, minute(1)), "fixture-rail")).toMatchObject({ status: "down", reason: "no receipt", period_s: 300 });
    persistRunReceipt(db, path, receipt("fixture-rail", 1));
    expect(railOf(doctor(path, db, minute(2)), "fixture-rail").status).toBe("ok");
    expect(railOf(doctor(path, db, minute(60)), "fixture-rail")).toMatchObject({ status: "down" });
    persistRunReceipt(db, path, receipt("fixture-rail", 61, { status: "failed", errors: ["fixture rail exploded"] }));
    expect(railOf(doctor(path, db, minute(62)), "fixture-rail").reason).toContain("last run failed: fixture rail exploded");
  });

  test("counts an empty streak only for a rail that expects output", () => {
    const probe = () => ({ count: 2, detail: "fixture backlog 2" });
    register({ id: "fixture-busy", expects_output: true, doctor: probe });
    register({ id: "fixture-quiet", expects_output: false });
    const { path, db } = vault();
    for (let n = 1; n <= 5; n += 1) {
      persistRunReceipt(db, path, receipt("fixture-busy", n));
      persistRunReceipt(db, path, receipt("fixture-quiet", n));
    }
    const report = doctor(path, db, minute(6));
    expect(railOf(report, "fixture-busy")).toMatchObject({ status: "down", empty_streak: 5, pending_work: 2 });
    expect(railOf(report, "fixture-busy").reason).toContain("empty streak 5 with work pending (fixture backlog 2)");
    expect(railOf(report, "fixture-quiet")).toMatchObject({ status: "ok", empty_streak: 0, pending_work: 0 });
    expect(report.failures.some((failure) => failure.startsWith("rail fixture-busy:"))).toBe(true);
  });

  test("a rail that reports findings by ending degraded is not down for it", () => {
    register({ id: "fixture-finder", degrades_on_findings: true });
    register({ id: "fixture-plain" });
    const { path, db } = vault();
    for (let n = 1; n <= 6; n += 1) {
      persistRunReceipt(db, path, receipt("fixture-finder", n, { status: "degraded", errors: ["finding"] }));
      persistRunReceipt(db, path, receipt("fixture-plain", n, { status: "degraded", errors: ["finding"] }));
    }
    const report = doctor(path, db, minute(7));
    expect(railOf(report, "fixture-finder").status).toBe("ok");
    expect(railOf(report, "fixture-plain").status).toBe("down");
  });
});

describe("a kill mid-run leaves a consistent receipt", () => {
  const schedule = (db: ReturnType<typeof vault>["db"]) => listSchedules(db).find((row) => row.rail === "fixture-rail")!;

  test("an interruption before the receipt lands leaves nothing to reconcile", async () => {
    const { path, db } = vault();
    register({ run: () => { throw new InjectedCrash("after-file"); } });
    seedSchedules(db);
    const before = schedule(db);
    await expect(runRail(db, path, "fixture-rail")).rejects.toBeInstanceOf(InjectedCrash);
    expect(listRunReceipts(db)).toEqual([]);
    expect(readRunReceiptsLog(path)).toEqual([]);
    expect(schedule(db)).toEqual(before);
  });

  for (const crashAfter of ["after-file", "after-jsonl", "after-db"] as const) {
    test(`a crash ${crashAfter} converges on one receipt and one schedule step`, async () => {
      const { path, db } = vault();
      register();
      seedSchedules(db);
      const first = schedule(db).next_run_at;
      await expect(runRail(db, path, "fixture-rail", { crashAfter })).rejects.toBeInstanceOf(InjectedCrash);
      recoverRunJournal(db, path);
      recoverRunJournal(db, path);
      const receipts = listRunReceipts(db).filter((item) => item.rail === "fixture-rail");
      expect(receipts).toHaveLength(crashAfter === "after-file" ? 0 : 1);
      expect(schedule(db).next_run_at !== first).toBe(crashAfter !== "after-file");
      const again = await runRail(db, path, "fixture-rail");
      expect(listRunReceipts(db).filter((item) => item.rail === "fixture-rail").map((item) => item.run_id))
        .toEqual([...receipts.map((item) => item.run_id), again.run_id]);
    });
  }

  for (const mode of ["in-run", "after-jsonl", "after-db"] as const) {
    test(`a process killed ${mode} leaves a consistent journal and ledger`, async () => {
      const { path, db } = vault();
      db.close();
      register({ id: "fixture-crash" });
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "rail-crash-child.ts"), path, mode], { stdout: "pipe", stderr: "pipe" });
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      const reopened = openLedger(join(path, ".kizuki", "kizuki.db"));
      disposers.push(() => reopened.close());
      recoverRunJournal(reopened, path);
      const receipts = listRunReceipts(reopened).filter((item) => item.rail === "fixture-crash");
      const journal = readRunReceiptsLog(path).filter((item) => item.rail === "fixture-crash");
      if (mode === "in-run") {
        expect(receipts).toEqual([]);
        expect(journal).toEqual([]);
      } else {
        expect(receipts).toHaveLength(1);
        expect(journal.map((item) => item.run_id)).toEqual(receipts.map((item) => item.run_id));
        expect(receipts[0]).toMatchObject({ status: "ok", events_synced: 1 });
      }
    });
  }
});

describe("the operator docs", () => {
  const START = "<!-- rails:start -->";
  const END = "<!-- rails:end -->";

  test("list the shipped rails exactly as the registry defines them", () => {
    const doc = readFileSync(DOC, "utf8");
    const table = renderRailsTable();
    if (process.env["KIZUKI_WRITE_RAILS_DOC"] === "1") {
      mkdirSync(dirname(DOC), { recursive: true });
      writeFileSync(DOC, doc.replace(new RegExp(`${START}[\\s\\S]*${END}`), `${START}\n${table}\n${END}`));
      return;
    }
    const body = doc.slice(doc.indexOf(START) + START.length, doc.indexOf(END)).trim();
    expect(body, "regenerate with: KIZUKI_WRITE_RAILS_DOC=1 ktest bun test packages/core/test/serve/rail-registry.test.ts --timeout 120000").toBe(table);
  });

  test("the operator seam catalogue names implementation and executable tests", () => {
    const root = join(import.meta.dir, "../../../..");
    const entries = JSON.parse(readFileSync(join(root, "docs/world/packet-seams.json"), "utf8")) as {
      packet: string; implementation: string[]; tests: string[]; docs: string;
    }[];
    const entry = entries.find((row) => row.packet === "F5")!;
    expect(entry).toBeDefined();
    for (const path of [...entry.implementation, ...entry.tests, entry.docs]) expect(existsSync(join(root, path))).toBe(true);
  });

  test("a rail registered at runtime stays out of the shipped table", () => {
    const before = renderRailsTable();
    register();
    expect(renderRailsTable()).toBe(before);
  });
});
