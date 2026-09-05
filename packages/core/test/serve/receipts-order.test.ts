import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { openLedger } from "../../src/ledger/db";
import { listRunReceipts, persistRunReceipt, pruneRunReceipts, readRunReceiptsLog } from "../../src/serve/receipts";
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
