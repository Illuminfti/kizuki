import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { openLedger } from "../../src/ledger/db";
import { listRunReceipts, persistRunReceipt, pruneRunReceipts, readModelRunHistory, readRunReceiptsLog } from "../../src/serve/receipts";
import { initServe } from "../../src/serve/schema";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { writeServeIntent } from "../../src/serve/intent";
import { emptyRunTotals, type RunReceipt } from "../../src/serve/types";

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "kizuki-recent-receipts-")); dirs.push(path); initVault(path);
  writeServeIntent(path, "opted-out");
  return { path, db: openLedger(join(path, ".kizuki/kizuki.db")) };
}
function receipt(run_id: string, rail = "sync", at = "2026-09-05T00:00:01Z"): RunReceipt {
  return { ...emptyRunTotals(), run_id, rail, started_at: at, finished_at: at, status: "ok", stopped: null };
}

test("limited receipt lists select the newest rows and return deterministic chronological order", () => {
  const { path, db } = fixture();
  try {
    for (const id of ["003", "001", "002"]) persistRunReceipt(db, path, receipt(id));
    persistRunReceipt(db, path, receipt("004", "embed", "2026-09-05T00:00:02Z"));
    persistRunReceipt(db, path, receipt("000", "sync", "2026-09-04T00:00:01Z"));
    for (const filter of [{}, { since: "2026-09-05T00:00:00Z" }]) {
      expect(listRunReceipts(db, { ...filter, limit: 2 }).map(row => row.run_id)).toEqual(["003", "004"]);
      expect(listRunReceipts(db, { ...filter, rail: "sync", limit: 2 }).map(row => row.run_id)).toEqual(["002", "003"]);
    }
  } finally { db.close(); }
});

test("new model failures remain visible beyond the receipt cap and through log pruning", () => {
  const { path, db } = fixture();
  const model = "kizuki.llm.openai-compatible:deepseek/deepseek-v4-flash-0731@openrouter.ai";
  try {
    const insert = db.query("INSERT INTO run_receipts(run_id,rail,started_at,finished_at,status,stopped,report) VALUES(?,?,?,?,?,?,?)");
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const old = receipt(`old-${String(i).padStart(5, "0")}`, "embed");
        insert.run(old.run_id, old.rail, old.started_at, old.finished_at, old.status, old.stopped, JSON.stringify(old));
      }
    }).immediate();
    persistRunReceipt(db, path, { ...receipt("latest-model-failure", "sync", "2026-09-05T00:00:02Z"), status: "degraded",
      model: { ...emptyRunTotals().model, calls: 1, model_ref: model, diagnostic: { stage: "response", rule: "unsupported_metadata" } } });
    const selected = listRunReceipts(db);
    expect(selected).toHaveLength(10_000);
    expect(selected.at(-1)?.run_id).toBe("latest-model-failure");
    const doctor = inspectServeDoctor(db, path, { model_ref: model, now: "2026-09-05T00:00:03Z" });
    expect(doctor.model.current_failure?.detail).toContain("unsupported metadata");
    expect(doctor.ok).toBe(false);
    expect(pruneRunReceipts(db, path, "2026-09-05T00:00:00Z").rewritten).toBe(10_000);
    expect(readRunReceiptsLog(path).at(-1)?.run_id).toBe("latest-model-failure");
  } finally { db.close(); }
});

for (const flood of ["embed", "current-noop", "other-model"] as const) {
  test(`model health remains failure or explicit unknown after a ${flood} flood`, () => {
    const { path, db } = fixture();
    const model = "synthetic:model";
    try {
      persistRunReceipt(db, path, { ...receipt("old-model-failure"), status: "degraded",
        model: { ...emptyRunTotals().model, calls: 1, model_ref: model,
          diagnostic: { stage: "response", rule: "unsupported_metadata" } } });
      const insert = db.query("INSERT INTO run_receipts(run_id,rail,started_at,finished_at,status,stopped,report) VALUES(?,?,?,?,?,?,?)");
      db.transaction(() => {
        for (let i = 0; i < 10_000; i++) {
          const later = { ...receipt(`flood-${String(i).padStart(5, "0")}`, flood === "embed" ? "embed" : "sync", "2026-09-05T00:00:02Z"),
            model: { ...emptyRunTotals().model, model_ref: flood === "current-noop" ? model : "other:model", calls: flood === "other-model" ? 1 : 0 } };
          insert.run(later.run_id, later.rail, later.started_at, later.finished_at, later.status, later.stopped, JSON.stringify(later));
        }
      }).immediate();
      const failed = inspectServeDoctor(db, path, { model_ref: model, now: "2026-09-05T00:00:03Z" });
      expect(failed.ok).toBe(false);
      expect(failed.model.history_truncated).toBe(flood !== "embed");
      expect(failed.model.history_unverified).toBe(flood !== "embed");
      if (flood === "embed") expect(failed.model.current_failure?.detail).toContain("unsupported metadata");
      else expect(failed.model.detail).toContain("selected history window");
      persistRunReceipt(db, path, { ...receipt("new-model-success", "sync", "2026-09-05T00:00:04Z"),
        model: { ...emptyRunTotals().model, calls: 1, model_ref: model } });
      const recovered = inspectServeDoctor(db, path, { model_ref: model, now: "2026-09-05T00:00:05Z" });
      expect(recovered.ok).toBe(true);
      expect(recovered.model.current_failure).toBeNull();
      expect(recovered.model.history_unverified).toBe(false);
      expect(recovered.model.history_truncated).toBe(flood !== "embed");
    } finally { db.close(); }
  });
}

for (const invalidJson of [false, true]) test(`a selected malformed current-model receipt stays unknown until a later valid attempt (invalid JSON=${invalidJson})`, () => {
  const { path, db } = fixture();
  const model = "synthetic:model";
  try {
    persistRunReceipt(db, path, { ...receipt("001"), model: { ...emptyRunTotals().model, calls: 1, model_ref: model } });
    const malformed = { ...receipt("002"), status: "not-a-status", model: { ...emptyRunTotals().model, calls: 1, model_ref: model } };
    db.query("INSERT INTO run_receipts(run_id,rail,started_at,finished_at,status,stopped,report) VALUES(?,?,?,?,?,?,?)")
      .run(malformed.run_id, malformed.rail, malformed.started_at, malformed.finished_at, "ok", null, invalidJson ? "{CANARY" : JSON.stringify(malformed));
    const unknown = inspectServeDoctor(db, path, { model_ref: model, now: "2026-09-05T00:00:03Z" });
    expect(unknown.ok).toBe(false);
    expect(unknown.model.history_unverified).toBe(true);
    expect(JSON.stringify(unknown.model)).not.toContain("not-a-status");
    persistRunReceipt(db, path, { ...receipt("003"), model: { ...emptyRunTotals().model, calls: 1, model_ref: model } });
    const recovered = inspectServeDoctor(db, path, { model_ref: model, now: "2026-09-05T00:00:03Z" });
    expect(recovered.ok).toBe(true);
    expect(recovered.model.history_unverified).toBe(false);
  } finally { db.close(); }
});

test("model history classification preserves invalid digest fallback", () => {
  const { path, db } = fixture();
  const model = "synthetic:model";
  try {
    const insert = db.query("INSERT INTO run_receipts(run_id,rail,started_at,finished_at,status,stopped,report) VALUES(?,?,?,?,?,?,?)");
    const invalidDigests = [undefined, null, false, 12, "A".repeat(64), "a".repeat(63), { secret: "CANARY" }];
    for (const [i, digest] of invalidDigests.entries()) {
      const legacy = { ...receipt(`legacy-${i}`), model: { ...emptyRunTotals().model, calls: 1, model_ref: model, model_ref_sha256: digest } };
      insert.run(legacy.run_id, legacy.rail, legacy.started_at, legacy.finished_at, legacy.status, null, JSON.stringify(legacy));
    }
    const other = { ...receipt("other-valid-digest"), model: { ...emptyRunTotals().model, calls: 1, model_ref: model, model_ref_sha256: "a".repeat(64) } };
    insert.run(other.run_id, other.rail, other.started_at, other.finished_at, other.status, null, JSON.stringify(other));
    persistRunReceipt(db, path, { ...receipt("new-valid-digest"), model: { ...emptyRunTotals().model, calls: 1, model_ref: model } });
    const selected = readModelRunHistory(db, "2026-09-05T00:00:00Z");
    expect(selected.receipts.filter(row => row?.run_id.startsWith("legacy-")).map(row => row?.model.model_ref_sha256)).toEqual(invalidDigests.map(() => undefined));
    expect(selected.truncated).toBe(false);
    expect(JSON.stringify(selected)).not.toContain("CANARY");
    const doctor = inspectServeDoctor(db, path, { model_ref: model, now: "2026-09-05T00:00:03Z" });
    expect(doctor.ok).toBe(true);
    expect(doctor.model.last_success_at).toBe("2026-09-05T00:00:01Z");
  } finally { db.close(); }
});

test("bounded receipt reads use ordered indexes after upgrading an existing ledger", () => {
  const { db } = fixture();
  try {
    db.exec("DROP INDEX IF EXISTS run_receipts_rail_finished_run; DROP INDEX IF EXISTS run_receipts_finished_run");
    initServe(db);
    const since = "2026-09-05T00:00:00Z";
    const reads: [() => unknown, (string | number)[]][] = [
      [() => listRunReceipts(db), [10_000]],
      [() => listRunReceipts(db, { since }), [since, 10_000]],
      [() => listRunReceipts(db, { rail: "sync" }), ["sync", 10_000]],
      [() => listRunReceipts(db, { rail: "sync", since }), ["sync", since, 10_000]],
      [() => readModelRunHistory(db, since), [since, 10_001]],
    ];
    for (const [read, bindings] of reads) {
      const original = db.query;
      let selectedQuery = "";
      db.query = ((query: string) => {
        if (query.includes("ORDER BY finished_at")) selectedQuery = query;
        return original.call(db, query);
      }) as typeof db.query;
      try { read(); } finally { db.query = original; }
      expect(selectedQuery).not.toBe("");
      const plan = db.query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${selectedQuery}`).all(...bindings);
      expect(plan.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
    }
  } finally { db.close(); }
});

test("bounded sync history preserves deterministic order across a large equal-time group", () => {
  const { path, db } = fixture();
  try {
    const insert = db.query("INSERT INTO run_receipts(run_id,rail,started_at,finished_at,status,stopped,report) VALUES(?,?,?,?,?,?,?)");
    db.transaction(() => {
      for (let i = 0; i < 10_010; i++) {
        const row = { ...receipt(`same-${String(i).padStart(5, "0")}`), model: { ...emptyRunTotals().model, model_ref: "other:model", calls: 1 } };
        insert.run(row.run_id, row.rail, row.started_at, row.finished_at, row.status, null, JSON.stringify(row));
      }
    }).immediate();
    const selected = readModelRunHistory(db, "2026-09-05T00:00:00Z");
    expect(selected.truncated).toBe(true);
    expect(selected.receipts).toHaveLength(10_000);
    expect(selected.receipts[0]?.run_id).toBe("same-00010");
    expect(selected.receipts.at(-1)?.run_id).toBe("same-10009");
    const unknown = inspectServeDoctor(db, path, { model_ref: "synthetic:model", now: "2026-09-05T00:00:03Z" });
    expect(unknown.model.history_unverified).toBe(true);
    expect(unknown.ok).toBe(false);
    persistRunReceipt(db, path, { ...receipt("zzzz-known-success"), model: { ...emptyRunTotals().model, model_ref: "synthetic:model", calls: 1 } });
    const recovered = inspectServeDoctor(db, path, { model_ref: "synthetic:model", now: "2026-09-05T00:00:03Z" });
    expect(recovered.model.history_truncated).toBe(true);
    expect(recovered.model.history_unverified).toBe(false);
    expect(recovered.ok).toBe(true);
  } finally { db.close(); }
});
