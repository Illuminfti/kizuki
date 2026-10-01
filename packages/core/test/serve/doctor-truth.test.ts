import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampDerived } from "../../src/derived-meta";
import { registerConnection } from "../../src/ledger/connections";
import { writeRailCursor } from "../../src/ledger/checkpoints";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { MODEL_PRODUCER_ID } from "../../src/producer";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { runRail } from "../../src/serve/rails";
import {
  persistRunReceipt,
  readModelRunHistory,
} from "../../src/serve/receipts";
import { writeServeIntent } from "../../src/serve/intent";
import {
  DEFAULT_RAILS,
  DOCTOR_RAIL_RECEIPTS,
  DOCTOR_SKIPPED_PAGES,
  emptyRunTotals,
  type RailId,
  type RunReceipt,
  type SupervisorStatus,
} from "../../src/serve/types";
import type { SupervisorHost } from "../../src/serve/supervisor";
import { initVault } from "../../src/vault/init";
import { validEvent } from "../fixtures";
import { throughputVault, ENDPOINT, MODEL } from "./throughput-fixture";

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const CONFIGURED =
  "kizuki.llm.openai-compatible:synthetic-model@models.example.test";
const ACTIVE: SupervisorStatus = {
  kind: "systemd",
  state: "active",
  unit: "kizuki@x.service",
  enabled: true,
  detail: "active",
};
const host = (status: SupervisorStatus = ACTIVE): SupervisorHost => ({
  kind: status.kind,
  home: "/tmp",
  execStart: "kizuki serve",
  query: () => status,
  reload: () => ({ ok: true, detail: "ok" }),
  enable: () => ({ ok: true, detail: "ok" }),
  disable: () => ({ ok: true, detail: "ok" }),
});

function vault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-doctor-truth-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  writeServeIntent(path, "installed");
  return { path, db: openLedger(join(path, ".kizuki", "kizuki.db")) };
}

/** Minute `n` after the fixture's capture time. */
const minute = (n: number): string =>
  new Date(Date.parse("2026-10-01T00:00:00Z") + n * 60_000).toISOString();

let serial = 0;
function run(
  rail: RailId,
  n: number,
  overrides: Partial<RunReceipt> = {},
): RunReceipt {
  serial += 1;
  return {
    ...emptyRunTotals(),
    run_id: `01JTRUTH${String(serial).padStart(18, "0")}`,
    rail,
    started_at: minute(n),
    finished_at: minute(n),
    status: "ok",
    stopped: null,
    ...overrides,
  };
}

function persistRuns(
  db: ReturnType<typeof openLedger>,
  path: string,
  rail: RailId,
  count: number,
  overrides: Partial<RunReceipt> = {},
  from = 0,
): string {
  for (let n = from + 1; n <= from + count; n += 1)
    persistRunReceipt(db, path, run(rail, n, overrides));
  return minute(from + count + 1);
}

function capture(
  db: ReturnType<typeof openLedger>,
  count: number,
): { event_id: string; accepted_at: string }[] {
  // Ledger acceptance uses wall time; pin it before the synthetic run history
  // without modifying append-only events or leaking a clock into later tests.
  setSystemTime(new Date(minute(0)));
  try {
    return Array.from({ length: count }, (_, index) => {
      const stored = accept(db, {
        ...validEvent(),
        source_record_id: `truth-${serial}-${index}`,
      });
      if (stored.status !== "stored") throw new Error("fixture capture failed");
      return {
        event_id: stored.event.event_id,
        accepted_at: db
          .query<{ accepted_at: string }, [string]>(
            "SELECT accepted_at FROM events WHERE event_id=?",
          )
          .get(stored.event.event_id)!.accepted_at,
      };
    });
  } finally { setSystemTime(); }
}

function railOf(report: ReturnType<typeof inspectServeDoctor>, rail: RailId) {
  const found = report.rails.find((item) => item.rail === rail);
  if (found === undefined) throw new Error(`missing rail ${rail}`);
  return found;
}

describe("rails judged by the work they have", () => {
  test("sync with an extract backlog that never produces is down, and the reason names the work", () => {
    const { path, db } = vault();
    capture(db, 3);
    const now = persistRuns(db, path, "sync", 5);
    const report = inspectServeDoctor(db, path, {
      now,
      supervisor: host(),
      configured_model_ref: CONFIGURED,
    });
    const sync = railOf(report, "sync");
    expect(sync.status).toBe("down");
    expect(sync.empty_streak).toBe(5);
    expect(sync.pending_work).toBe(3);
    expect(sync.reason).toContain("empty streak 5");
    expect(sync.reason).toContain("extract backlog 3");
    expect(report.ok).toBe(false);
    expect(
      report.failures.some(
        (failure) =>
          failure.startsWith("rail sync:") &&
          failure.includes("extract backlog 3"),
      ),
    ).toBe(true);
    db.close();
  });

  test("work that arrived after the runs is not counted against them", () => {
    const { path, db } = vault();
    // Five runs from days before the events below were accepted.
    const day = (n: number) => `2026-09-2${n}T00:00:00.000Z`;
    for (let n = 0; n < 5; n += 1) persistRunReceipt(db, path, run("sync", 0, { started_at: day(n), finished_at: day(n) }));
    capture(db, 2);
    const report = inspectServeDoctor(db, path, {
      now: new Date(Date.parse(day(4)) + 60_000).toISOString(),
      supervisor: host(),
      configured_model_ref: CONFIGURED,
    });
    const sync = railOf(report, "sync");
    expect(sync.pending_work).toBe(2);
    expect(sync.empty_streak).toBe(0);
    expect(sync.status).toBe("ok");
    db.close();
  });

  test("the extract cursor takes events out of the backlog", () => {
    const { path, db } = vault();
    const events = capture(db, 3);
    const first = report(db, path, minute(1));
    expect(first.extraction.backlog_events).toBe(3);
    const second = events[1]!;
    writeRailCursor(
      db,
      MODEL_PRODUCER_ID,
      "extract",
      `${second.accepted_at}\t${second.event_id}`,
    );
    // Events past the cursor: those after the second in ledger order.
    const remaining = report(db, path, minute(1)).extraction.backlog_events;
    expect(remaining).toBeLessThanOrEqual(1);
    const last = events[2]!;
    writeRailCursor(
      db,
      MODEL_PRODUCER_ID,
      "extract",
      `${last.accepted_at}\t${last.event_id}`,
    );
    expect(report(db, path, minute(1)).extraction.backlog_events).toBe(0);
    db.close();
  });

  test("with no model configured a backlog is not the sync rail's work", () => {
    const { path, db } = vault();
    capture(db, 3);
    const now = persistRuns(db, path, "sync", 6);
    const sync = railOf(
      inspectServeDoctor(db, path, { now, supervisor: host() }),
      "sync",
    );
    expect(sync.pending_work).toBe(0);
    expect(sync.status).toBe("ok");
    db.close();
  });

  test("maintenance rails are judged by staleness and failure, never by an empty streak", () => {
    const { path, db } = vault();
    capture(db, 2);
    const rails = ["brief", "journal-prune", "doctor-sweep", "purge-sweep", "embed-backfill"] as const;
    for (const rail of rails) persistRuns(db, path, rail, 8);
    const report = inspectServeDoctor(db, path, {
      now: new Date(Date.parse(minute(8)) + 30_000).toISOString(),
      supervisor: host(),
      configured_model_ref: CONFIGURED,
    });
    for (const rail of rails) {
      const item = railOf(report, rail);
      expect(item.status).toBe("ok");
      expect(item.empty_streak).toBe(0);
      expect(item.pending_work).toBe(0);
    }
    db.close();
  });

  test("a schedule-driven rail still goes down when it goes stale or fails", () => {
    const { path, db } = vault();
    persistRunReceipt(db, path, run("brief", 1));
    persistRunReceipt(db, path, run("journal-prune", 1, { status: "failed", errors: ["prune could not open the journal"] }));
    const stale = inspectServeDoctor(db, path, { now: new Date(Date.parse(minute(1)) + 4 * 86_400_000).toISOString(), supervisor: host() });
    expect(railOf(stale, "brief").status).toBe("down");
    expect(railOf(stale, "brief").reason).toContain("stale");
    const prune = railOf(inspectServeDoctor(db, path, { now: minute(2), supervisor: host() }), "journal-prune");
    expect(prune.status).toBe("down");
    expect(prune.reason).toContain("last run failed: prune could not open the journal");
    db.close();
  });

  test("embed-backfill judges its own reported backlog only when an embedding port is configured", () => {
    const { path, db } = vault();
    const now = persistRuns(db, path, "embed-backfill", 6, {
      retrieval: { upserts: 0, removals: 0, pending_ops: 4, degraded: [] },
    });
    const off = railOf(
      inspectServeDoctor(db, path, { now, supervisor: host() }),
      "embed-backfill",
    );
    expect(off.status).toBe("ok");
    const on = railOf(
      inspectServeDoctor(db, path, {
        now,
        supervisor: host(),
        embedding_configured: true,
      }),
      "embed-backfill",
    );
    expect(on.status).toBe("down");
    expect(on.reason).toContain("empty streak 6");
    db.close();
  });

  test("retrieval-sweep: pending ops that never drain are down, an idle sweep is healthy", () => {
    const { path, db } = vault();
    const idle = persistRuns(db, path, "retrieval-sweep", 6);
    expect(railOf(inspectServeDoctor(db, path, { now: idle, supervisor: host() }), "retrieval-sweep").status).toBe("ok");
    db.query(
      `INSERT INTO retrieval_ops (op_id, store, op, doc_id, state, created_at, done_at)
       VALUES ('op-1', 'kizuki.retrieval.fts5', 'upsert', 'page:facts/a', 'pending', ?, NULL)`,
    ).run(minute(10));
    const now = persistRuns(db, path, "retrieval-sweep", 6, { retrieval: { upserts: 0, removals: 0, pending_ops: 1, degraded: [] } }, 10);
    const stuck = railOf(inspectServeDoctor(db, path, { now, supervisor: host() }), "retrieval-sweep");
    expect(stuck.status).toBe("down");
    expect(stuck.reason).toContain("pending retrieval ops 1");
    db.close();
  });
});

describe("rails that keep ending badly", () => {
  const truncated = {
    status: "degraded" as const,
    errors: ["model response rejected: response truncated", "schema_invalid"],
  };

  test("a degraded streak is down with the dominant error, whatever the backlog", () => {
    const { path, db } = vault();
    const now = persistRuns(db, path, "sync", 5, truncated);
    const sync = railOf(
      inspectServeDoctor(db, path, { now, supervisor: host() }),
      "sync",
    );
    expect(sync.status).toBe("down");
    expect(sync.degraded_streak).toBe(5);
    expect(sync.reason).toContain("last 5 runs ended degraded");
    expect(sync.reason).toContain(
      "model response rejected: response truncated",
    );
    db.close();
  });

  test("four degraded runs are not yet a streak, and a good run ends one", () => {
    const { path, db } = vault();
    for (let n = 1; n <= 4; n += 1)
      persistRunReceipt(db, path, run("sync", n, truncated));
    expect(
      railOf(
        inspectServeDoctor(db, path, { now: minute(5), supervisor: host() }),
        "sync",
      ).status,
    ).toBe("ok");
    persistRunReceipt(db, path, run("sync", 5));
    for (let n = 6; n <= 9; n += 1)
      persistRunReceipt(db, path, run("sync", n, truncated));
    const sync = railOf(
      inspectServeDoctor(db, path, { now: minute(10), supervisor: host() }),
      "sync",
    );
    expect(sync.degraded_streak).toBe(4);
    expect(sync.status).toBe("ok");
    db.close();
  });

  test("a stopped streak names why the runs stopped", () => {
    const { path, db } = vault();
    const now = persistRuns(db, path, "sync", 5, {
      status: "stopped",
      stopped: "budget:canon_writes_per_day",
    });
    const sync = railOf(
      inspectServeDoctor(db, path, { now, supervisor: host() }),
      "sync",
    );
    expect(sync.status).toBe("down");
    expect(sync.reason).toContain("ended stopped");
    expect(sync.reason).toContain("stopped budget:canon_writes_per_day");
    db.close();
  });

  test("a failed last run says why it failed", () => {
    const { path, db } = vault();
    persistRunReceipt(
      db,
      path,
      run("sync", 1, {
        status: "failed",
        errors: ["extraction interrupted after model decision"],
      }),
    );
    const sync = railOf(
      inspectServeDoctor(db, path, { now: minute(2), supervisor: host() }),
      "sync",
    );
    expect(sync.status).toBe("down");
    expect(sync.reason).toBe(
      "last run failed: extraction interrupted after model decision",
    );
    db.close();
  });

  test("the sweep reports other checks, so its own degraded runs are not a rail fault", () => {
    const { path, db } = vault();
    const now = persistRuns(db, path, "doctor-sweep", 6, {
      status: "degraded",
      errors: ["model response rejected: response truncated"],
    });
    const sweep = railOf(
      inspectServeDoctor(db, path, { now, supervisor: host() }),
      "doctor-sweep",
    );
    expect(sweep.status).toBe("ok");
    expect(sweep.degraded_streak).toBe(6);
    db.close();
  });
});

describe("the doctor sweep tells the truth about doctor", () => {
  test("an ok sweep on a healthy vault, a degraded one naming the failure on a broken one", async () => {
    const { path, db } = vault();
    const healthy = await runRail(db, path, "doctor-sweep", {
      hooks: { model_ref: null },
    });
    expect(healthy.status).toBe("ok");
    expect(healthy.errors).toEqual([]);

    const now = Date.now();
    persistRunReceipt(db, path, {
      ...run("sync", 0),
      started_at: new Date(now - 30_000).toISOString(),
      finished_at: new Date(now - 20_000).toISOString(),
      status: "degraded",
      model: {
        ...emptyRunTotals().model,
        calls: 1,
        model_ref: CONFIGURED,
        last_request: "failed",
        diagnostic: { stage: "response", rule: "response_truncated" },
      },
      errors: ["model response rejected: response truncated"],
    });
    const broken = await runRail(db, path, "doctor-sweep", {
      hooks: { model_ref: CONFIGURED },
    });
    expect(broken.status).toBe("degraded");
    expect(
      broken.errors.some((error) =>
        error.includes("model response rejected: response truncated"),
      ),
    ).toBe(true);
    // The service's own supervisor is not the sweep's to judge.
    expect(broken.errors.some((error) => error.startsWith("supervisor"))).toBe(
      false,
    );
    db.close();
  });
});

describe("receipt reads are bounded", () => {
  test("a rail's streak reads at most the newest window", () => {
    const { path, db } = vault();
    const count = DOCTOR_RAIL_RECEIPTS + 10;
    const now = persistRuns(db, path, "journal-prune", count, {
      status: "degraded",
      errors: ["prune could not open the journal"],
    });
    const item = railOf(
      inspectServeDoctor(db, path, {
        now: new Date(Date.parse(now) + 60_000).toISOString(),
        supervisor: host(),
      }),
      "journal-prune",
    );
    expect(item.degraded_streak).toBe(DOCTOR_RAIL_RECEIPTS);
    db.close();
  }, 60_000);

  test("the sync history window truncates instead of loading every receipt", () => {
    const { path, db } = vault();
    persistRuns(db, path, "sync", 6);
    const history = readModelRunHistory(db, "2026-01-01T00:00:00Z", 4);
    expect(history.receipts).toHaveLength(4);
    expect(history.truncated).toBe(true);
    db.close();
  });
});

function report(db: ReturnType<typeof openLedger>, path: string, now: string) {
  return inspectServeDoctor(db, path, {
    now,
    supervisor: host(),
    configured_model_ref: CONFIGURED,
  });
}

describe("the model and extraction lines follow the daemon", () => {
  const failed = (n: number, model_ref = CONFIGURED): RunReceipt =>
    run("sync", n, {
      status: "degraded",
      errors: ["model response rejected: response truncated"],
      model: {
        ...emptyRunTotals().model,
        calls: 1,
        model_ref,
        last_request: "failed",
        diagnostic: { stage: "response", rule: "response_truncated" },
      },
    });
  const answered = (n: number): RunReceipt =>
    run("sync", n, {
      model: {
        ...emptyRunTotals().model,
        calls: 1,
        answered: 1,
        last_request: "answered",
        model_ref: CONFIGURED,
      },
    });

  test("a shell without the secret reads the daemon's receipts under the ref with the host", () => {
    const { path, db } = vault();
    persistRunReceipt(db, path, answered(1));
    for (let n = 2; n <= 4; n += 1) persistRunReceipt(db, path, failed(n));
    const shell = report(db, path, minute(5));
    expect(shell.model.canon_writing).toBe("configured");
    expect(shell.model.model_ref).toBeNull();
    expect(shell.model.last_success_at).toBe(minute(1));
    expect(shell.model.last_failure).toEqual({
      at: minute(4),
      detail: "model response rejected: response truncated",
    });
    expect(shell.model.consecutive_failures).toBe(3);
    expect(shell.model.detail).toBe(
      `canon writing: configured; daemon last_success=${minute(1)} last_failure=model response rejected: response truncated at ${minute(4)} consecutive_failures=3`,
    );
    expect(shell.model.detail).not.toContain("unverified");
    expect(
      shell.failures.some((failure) => failure.includes("response truncated")),
    ).toBe(true);
    db.close();
  });

  test("a ref without the host cannot see the daemon's receipts, which is the defect", () => {
    const { path, db } = vault();
    persistRunReceipt(db, path, failed(1));
    const hostless = inspectServeDoctor(db, path, {
      now: minute(2),
      supervisor: host(),
      configured_model_ref: "kizuki.llm.openai-compatible:synthetic-model",
    });
    expect(hostless.model.canon_writing).toBe("unverified");
    expect(hostless.model.last_failure).toBeNull();
    db.close();
  });

  test("unverified only when the daemon left no receipts for the model", () => {
    const { path, db } = vault();
    const none = report(db, path, minute(1));
    expect(none.model.canon_writing).toBe("unverified");
    expect(none.model.detail).toContain("unverified");
    persistRunReceipt(
      db,
      path,
      failed(
        1,
        "kizuki.llm.openai-compatible:another-model@models.example.test",
      ),
    );
    expect(report(db, path, minute(2)).model.canon_writing).toBe("unverified");
    persistRunReceipt(db, path, answered(3));
    const seen = report(db, path, minute(4));
    expect(seen.model.canon_writing).toBe("configured");
    expect(seen.model.consecutive_failures).toBe(0);
    expect(seen.model.detail).toContain("consecutive_failures=0");
    db.close();
  });

  test("a bound model keeps its own line", () => {
    const { path, db } = vault();
    persistRunReceipt(db, path, answered(1));
    const bound = inspectServeDoctor(db, path, {
      now: minute(2),
      supervisor: host(),
      model_ref: CONFIGURED,
      reasoning_effort: "low",
    });
    expect(bound.model.canon_writing).toBe("on");
    expect(bound.model.detail).toStartWith(
      `canon writing: on (${CONFIGURED}, reasoning_effort=low);`,
    );
    db.close();
  });

  test("repeated truncation says what to change; older receipts without it say nothing", () => {
    const { path, db } = vault();
    persistRunReceipt(db, path, run("sync", 1));
    for (let n = 2; n <= 3; n += 1) persistRunReceipt(db, path, failed(n));
    expect(report(db, path, minute(4)).extraction.hint).toBeNull();
    persistRunReceipt(db, path, failed(4));
    const extraction = report(db, path, minute(5)).extraction;
    expect(extraction.consecutive_rejections).toBe(3);
    expect(extraction.hint).toContain("[ports.llm] reasoning_effort");
    expect(extraction.hint).toContain("[extraction] max_output_tokens");
    expect(extraction.detail).toContain(extraction.hint ?? "");
    persistRunReceipt(db, path, answered(5));
    expect(report(db, path, minute(6)).extraction.hint).toBeNull();
    db.close();
  });

  test("the extraction line has the backlog and when a claim last came out", () => {
    const { path, db } = vault();
    capture(db, 2);
    const before = report(db, path, minute(1)).extraction;
    expect(before.backlog_events).toBe(2);
    expect(before.backlog_capped).toBe(false);
    expect(before.last_extracted_at).toBeNull();
    expect(before.detail).toBe("extraction backlog=2 last_extracted_at=never");
    const off = inspectServeDoctor(db, path, {
      now: minute(1),
      supervisor: host(),
    }).extraction;
    expect(off.detail).toContain("(no model: nothing extracts)");
    db.close();
  });

  test("only events a granted source sends to a model are backlog", () => {
    const fixture = throughputVault(3);
    dirs.push(fixture.root);
    const db = openLedger(fixture.ledger);
    const otherKey = "01J00000000000000000000XYZ";
    registerConnection(db, "kizuki.other", otherKey);
    setSourceGrant(db, {
      source_key: otherKey,
      expected_revision: 0,
      operation_id: "truth-local-grant",
      policy: {
        purposes: ["capture", "recall", "extract"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "public",
      },
    });
    const kept = accept(
      db,
      {
        ...validEvent(),
        connector_id: "kizuki.other",
        source_record_id: "local-1",
        subjects: [],
      },
      { source: { source_key: otherKey, expected_revision: 1 } },
    );
    expect(kept.status).toBe("stored");
    const extraction = report(db, fixture.vault, minute(1)).extraction;
    expect(extraction.backlog_events).toBe(3);
    db.close();
  });
});

describe("egress and skipped pages", () => {
  test("every source with model egress names host, model and retention", () => {
    const fixture = throughputVault(1);
    dirs.push(fixture.root);
    const db = openLedger(fixture.ledger);
    const egress = report(db, fixture.vault, minute(1)).egress;
    expect(egress).toEqual([
      {
        source_key: "01J00000000000000000000SRC",
        connector_id: "kizuki.fixture",
        endpoint_host: new URL(ENDPOINT).host,
        model: MODEL,
        retention: "provider_managed",
      },
    ]);
    db.close();
  });

  test("a source that never leaves the machine is not listed", () => {
    const { path, db } = vault();
    expect(report(db, path, minute(1)).egress).toEqual([]);
    db.close();
  });

  test("a degraded stamp with no file skipped now is shown as a stale stamp, not index-degraded", () => {
    const { path, db } = vault();
    stampDerived(db, {
      layer: "search",
      generation: "gen-1",
      rebuilt_at: "2026-09-02T12:00:00.000Z",
      doc_count: 4,
      source_count: 4,
      skipped_count: 5,
      status: "degraded",
    });
    const stores = report(db, path, minute(1)).stores;
    expect(stores.derived.search).toMatchObject({ status: "degraded", skipped_count: 5, doc_count: 4 });
    expect(stores.skipped_pages_total).toBe(0);
    expect(stores.degraded).not.toContain("index-degraded");
    db.close();
  });

  test("skipped canon files are listed, bounded, and index-degraded needs one", () => {
    const { path, db } = vault();
    expect(report(db, path, minute(1)).stores.degraded).not.toContain(
      "index-degraded",
    );
    mkdirSync(join(path, "facts"), { recursive: true });
    const total = DOCTOR_SKIPPED_PAGES + 4;
    for (let index = 0; index < total; index += 1) {
      writeFileSync(
        join(path, "facts", `broken-${String(index).padStart(2, "0")}.md`),
        "---\nnot: [valid\n---\nbody\n",
      );
    }
    const stores = report(db, path, minute(1)).stores;
    expect(stores.degraded).toContain("index-degraded");
    expect(stores.skipped_pages_total).toBe(total);
    expect(stores.skipped_pages).toHaveLength(DOCTOR_SKIPPED_PAGES);
    expect(stores.skipped_pages[0]).toEqual({
      path: "facts/broken-00.md",
      reason: expect.any(String),
    });
    db.close();
  });
});

describe("degraded runs that are making progress", () => {
  const behind = ["derived-index-behind"];

  test("a retrieval-sweep draining a large backlog in bounded passes stays healthy", () => {
    const { path, db } = vault();
    for (let n = 1; n <= 6; n += 1) {
      persistRunReceipt(
        db,
        path,
        run("retrieval-sweep", n, {
          status: "degraded",
          retrieval: {
            upserts: 200,
            removals: 0,
            pending_ops: 4800 - n * 200,
            degraded: behind,
          },
        }),
      );
    }
    const sweep = railOf(
      inspectServeDoctor(db, path, { now: minute(7), supervisor: host() }),
      "retrieval-sweep",
    );
    expect(sweep.status).toBe("ok");
    expect(sweep.degraded_streak).toBe(0);
    db.close();
  });

  test("a shrinking pending count is progress even when no record was applied", () => {
    const { path, db } = vault();
    for (let n = 1; n <= 6; n += 1) {
      persistRunReceipt(
        db,
        path,
        run("retrieval-sweep", n, {
          status: "degraded",
          retrieval: { upserts: 0, removals: 0, pending_ops: 100 - n, degraded: behind },
        }),
      );
    }
    const sweep = railOf(
      inspectServeDoctor(db, path, { now: minute(7), supervisor: host() }),
      "retrieval-sweep",
    );
    expect(sweep.status).toBe("ok");
    db.close();
  });

  test("a stuck retrieval-sweep is down and its reason names the degradation code", () => {
    const { path, db } = vault();
    const now = persistRuns(db, path, "retrieval-sweep", 6, {
      status: "degraded",
      errors: [],
      retrieval: { upserts: 0, removals: 0, pending_ops: 4800, degraded: behind },
    });
    const sweep = railOf(
      inspectServeDoctor(db, path, { now, supervisor: host() }),
      "retrieval-sweep",
    );
    expect(sweep.status).toBe("down");
    expect(sweep.reason).toContain("last 6 runs ended degraded");
    expect(sweep.reason).toContain("derived-index-behind");
    db.close();
  });

  test("embed-backfill and purge-sweep name what they report in retrieval.degraded", () => {
    const { path, db } = vault();
    persistRuns(db, path, "embed-backfill", 5, {
      status: "degraded",
      retrieval: { upserts: 0, removals: 0, pending_ops: 7, degraded: ["embedding-unavailable"] },
    });
    const now = persistRuns(db, path, "purge-sweep", 5, {
      status: "degraded",
      retrieval: { upserts: 0, removals: 0, pending_ops: 2, degraded: ["purge-ops-pending"] },
    });
    const report = inspectServeDoctor(db, path, { now, supervisor: host() });
    expect(railOf(report, "embed-backfill").reason).toContain("embedding-unavailable");
    expect(railOf(report, "purge-sweep").reason).toContain("purge-ops-pending");
    db.close();
  });

  test("degraded runs from a service nobody expects to run are not a current failure", () => {
    const { path, db } = vault();
    persistRuns(db, path, "sync", 5, { status: "degraded", errors: ["model unavailable"] });
    const later = new Date(Date.parse(minute(6)) + 3 * 86_400_000).toISOString();
    const abandoned = railOf(inspectServeDoctor(db, path, { now: later }), "sync");
    expect(abandoned.status).toBe("ok");
    const fresh = railOf(inspectServeDoctor(db, path, { now: minute(6) }), "sync");
    expect(fresh.status).toBe("down");
    expect(fresh.reason).toContain("model unavailable");
    db.close();
  });
});

describe("extraction progress is not an empty run", () => {
  test.each([
    ["claims that all deduplicated", { claims_deduped: 2 }],
    ["drafts extracted and not yet written", { claims_extracted: 3 }],
    ["records skipped as too large", { records_skipped: 1 }],
  ] as const)("%s shrink the backlog", (_name, progress) => {
    const { path, db } = vault();
    capture(db, 4);
    const now = persistRuns(db, path, "sync", 6, progress);
    const sync = railOf(
      inspectServeDoctor(db, path, {
        now,
        supervisor: host(),
        configured_model_ref: CONFIGURED,
      }),
      "sync",
    );
    expect(sync.status).toBe("ok");
    expect(sync.empty_streak).toBe(0);
    db.close();
  });
});

describe("the streak walk is bounded", () => {
  test("a long stuck history reports at least the verdict and runs one unwritten-claim scan", () => {
    const { path, db } = vault();
    capture(db, 2);
    const now = persistRuns(db, path, "sync", 60);
    const seen: string[] = [];
    const spied = new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property !== "query" || typeof value !== "function") return value;
        return (sql: string) => {
          seen.push(sql);
          return (value as (text: string) => unknown).call(target, sql);
        };
      },
    });
    const report = inspectServeDoctor(spied, path, {
      now,
      supervisor: host(),
      configured_model_ref: CONFIGURED,
    });
    const sync = railOf(report, "sync");
    expect(sync.status).toBe("down");
    expect(sync.empty_streak).toBe(10);
    expect(sync.reason).toContain("empty streak 10+");
    // One full count for the report, one scan for the oldest claim, none per run.
    const scans = seen.filter((sql) => sql.includes("receipt_id IS NULL"));
    expect(scans.length).toBeLessThanOrEqual(2);
    db.close();
  });
});

describe("doctor names its top failure as data", () => {
  test("a failing rail is the top failure with its id, a healthy report has none", () => {
    const { path, db } = vault();
    for (const spec of DEFAULT_RAILS) persistRunReceipt(db, path, run(spec.rail, 1));
    const healthy = inspectServeDoctor(db, path, { now: minute(2), supervisor: host() });
    expect(healthy.failures).toEqual([]);
    expect(healthy.top_failure).toBeNull();
    const stale = inspectServeDoctor(db, path, {
      now: new Date(Date.parse(minute(1)) + 4 * 86_400_000).toISOString(),
      supervisor: host(),
    });
    expect(stale.failures[0]).toContain("rail ");
    expect(stale.top_failure?.kind).toBe("rail");
    expect(stale.top_failure?.rail).not.toBeNull();
    db.close();
  });

  test("a failing model attempt is the top failure of kind model", () => {
    const { path, db } = vault();
    persistRunReceipt(
      db,
      path,
      run("sync", 1, {
        model: {
          ...emptyRunTotals().model,
          calls: 1,
          model_ref: CONFIGURED,
          last_request: "failed",
          diagnostic: { stage: "response", rule: "response_truncated" },
        },
      }),
    );
    const found = inspectServeDoctor(db, path, {
      now: minute(2),
      supervisor: host(),
      configured_model_ref: CONFIGURED,
    });
    expect(found.top_failure).toEqual({ kind: "model", rail: null });
    db.close();
  });
});

describe("index state and the page walk", () => {
  test("a page held out of the index is index-degraded, and rebuild is not offered for it", () => {
    const { path, db } = vault();
    db.query(
      "INSERT INTO canon_holds (page_path, proposal_id, reason, held_at) VALUES ('facts/held.md', 'p1', 'review', ?)",
    ).run(minute(0));
    const stores = report(db, path, minute(1)).stores;
    expect(stores.held_pages).toBe(1);
    expect(stores.skipped_pages_total).toBe(0);
    expect(stores.degraded).toContain("index-degraded");
    expect(stores.pages_truncated).toBe(false);
    db.close();
  });

  test("the sweep and rebuild can skip the canon page walk", () => {
    const { path, db } = vault();
    mkdirSync(join(path, "facts"), { recursive: true });
    writeFileSync(join(path, "facts", "broken.md"), "---\nnot: [valid\n---\nbody\n");
    const walked = inspectServeDoctor(db, path, { now: minute(1), supervisor: host() });
    expect(walked.stores.skipped_pages_total).toBe(1);
    const skipped = inspectServeDoctor(db, path, { now: minute(1), supervisor: host(), page_walk: false });
    expect(skipped.stores.skipped_pages_total).toBe(0);
    expect(skipped.stores.pages_truncated).toBe(false);
    db.close();
  });
});
