import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProduceResult, ProducerPort } from "../../src/contracts/producer";
import { createBudgetTracker } from "../../src/canon/budget";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { runRail } from "../../src/serve/rails";
import { runWritePass } from "../../src/serve/write-pass";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { readExtractCursor } from "../../src/serve/extract";
import { getRunReceipt, listRunReceipts, parseRunReceipt, persistRunReceipt, pruneRunReceipts } from "../../src/serve/receipts";
import { emptyRunTotals } from "../../src/serve/types";
import { putEvent } from "../claims/helpers";

const MODEL = "model:synthetic";
const CANARY = "synthetic-private-diagnostic-canary";
const diagnostic = { stage: "claims", field: "predicate", rule: "bounded_string", shape: "object", claim_index: 0, claim_count: 2 } as const;
const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "kizuki-model-diagnostic-")); dirs.push(path); initVault(path);
  const db = openLedger(join(path, ".kizuki/kizuki.db"));
  putEvent(db, { source_record_id: "synthetic-diagnostics" });
  return { path, db };
}
function producer(result: ProduceResult): ProducerPort {
  return { descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 2, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready", detail: {} }), close: async () => {}, produce: async () => result };
}
const rejected = (detail: unknown = diagnostic): ProduceResult => ({ status: "rejected", reason: "schema_invalid", usage: { calls: 1, input_tokens: 12, output_tokens: 4 }, diagnostic: detail as never });

describe("native model diagnostics", () => {
  test("a failed result survives usage journaling, recovery, receipt read and doctor", async () => {
    const { path, db } = fixture();
    try {
      const pass = await runWritePass(db, path, { run_id: "diagnostic-interrupted", model_ref: MODEL, claims: { db }, budget: createBudgetTracker({ canon_writes_per_run: 4 }), producer: producer(rejected()) });
      expect(pass.model.diagnostic).toEqual(diagnostic);
      expect(pass.errors.join(" ")).toContain("field=predicate");
      expect(readExtractCursor(db)).toBeNull();
      const row = db.query<{ metrics: string }, []>("SELECT metrics FROM extract_usage").get()!;
      expect(JSON.parse(row.metrics).model.diagnostic).toEqual(diagnostic);
      // Simulate the already-proven orphan-owner condition after a delivered result.
      db.exec("UPDATE extract_usage SET holder_pid=-1");
      await runRail(db, path, "doctor-sweep");
      const receipt = getRunReceipt(db, "diagnostic-interrupted")!;
      expect(receipt.model.diagnostic).toEqual(diagnostic);
      expect(receipt.model.model_ref_sha256).toMatch(/^[a-f0-9]{64}$/);
      const doctor = inspectServeDoctor(db, path, { model_ref: MODEL });
      expect(doctor.model.last_success_at).toBeNull();
      expect(doctor.model.last_failure?.detail).toContain("field=predicate");
      expect(readFileSync(join(path, ".kizuki/run-receipts.jsonl"), "utf8")).not.toContain(CANARY);
    } finally { db.close(); }
  });

  test("untrusted port diagnostic fields are excluded before durable publication", async () => {
    const { path, db } = fixture();
    try {
      for (const unsafe of [{ ...diagnostic, field: CANARY }, { ...diagnostic, rule: CANARY }, { ...diagnostic, [CANARY]: CANARY }]) {
        const receipt = await runRail(db, path, "sync", { hooks: { model_ref: MODEL, claims: { db }, producer: producer(rejected(unsafe)) } });
        expect(receipt.model.diagnostic).toBeUndefined();
      }
      expect(JSON.stringify(listRunReceipts(db))).not.toContain(CANARY);
      expect(readFileSync(join(path, ".kizuki/run-receipts.jsonl"), "utf8")).not.toContain(CANARY);
    } finally { db.close(); }
  });

  test("receipt parsing drops raw diagnostic payloads and keeps the fixed structure", () => {
    const raw = { ...emptyRunTotals(), run_id: "diag", rail: "sync", started_at: "2026-09-05T00:00:00Z", finished_at: "2026-09-05T00:00:01Z", status: "degraded", stopped: null,
      model: { ...emptyRunTotals().model, diagnostic } };
    expect(parseRunReceipt(raw)?.model.diagnostic).toEqual(diagnostic);
    expect(JSON.stringify(parseRunReceipt({ ...raw, model: { ...raw.model, diagnostic: { ...diagnostic, detail: CANARY } } }))).not.toContain(CANARY);
  });

  test("doctor shows a later rejection despite prior success and scopes model identity", () => {
    const { path, db } = fixture();
    const persist = (id: string, second: number, model: string, failed: boolean) => persistRunReceipt(db, path, { ...emptyRunTotals(), run_id: id, rail: "sync", started_at: `2026-09-05T00:00:0${second}Z`, finished_at: `2026-09-05T00:00:0${second}Z`, status: failed ? "degraded" : "ok", stopped: null,
      claims_rejected: failed ? { schema_invalid: 1 } : {}, model: { ...emptyRunTotals().model, model_ref: model, calls: 1, ...(failed ? { diagnostic } : {}) } });
    try {
      persist("old-success", 1, "model:other", false);
      persist("current-success", 2, MODEL, false);
      persist("current-failed", 3, MODEL, true);
      const report = inspectServeDoctor(db, path, { model_ref: MODEL, now: "2026-09-05T00:00:04Z" });
      expect(report.model.last_success_at).toBe("2026-09-05T00:00:02Z");
      expect(report.model.last_failure?.at).toBe("2026-09-05T00:00:03Z");
      expect(report.failures.some(value => value.includes("field=predicate"))).toBe(true);
      expect(inspectServeDoctor(db, path, { model_ref: "model:new", now: "2026-09-05T00:00:04Z" }).model.last_success_at).toBeNull();
    } finally { db.close(); }
  });
});

test("long model references keep distinct private receipt identities and independent success/failure history", () => {
  const { path, db } = fixture();
  const firstModel = "kizuki.llm.openai-compatible:deepseek/deepseek-v4-flash-0731@openrouter.ai";
  const otherModel = "kizuki.llm.openai-compatible:deepseek/deepseek-v4-flash-0732@openrouter.ai";
  const persist = (id: string, second: number, model: string, failed: boolean) => persistRunReceipt(db, path, {
    ...emptyRunTotals(), run_id: id, rail: "sync", started_at: `2026-09-05T00:00:0${second}Z`, finished_at: `2026-09-05T00:00:0${second}Z`,
    status: failed ? "degraded" : "ok", stopped: null, model: { ...emptyRunTotals().model, model_ref: model, calls: 1, ...(failed ? { diagnostic } : {}) },
  });
  try {
    persist("first-failed", 1, firstModel, true);
    persist("other-success", 2, otherModel, false);
    persist("first-success", 3, firstModel, false);
    const first = getRunReceipt(db, "first-failed")!, otherReceipt = getRunReceipt(db, "other-success")!;
    expect(first.model.model_ref).toBe(otherReceipt.model.model_ref); // The existing display redactor intentionally collides.
    expect(first.model.model_ref_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(otherReceipt.model.model_ref_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.model.model_ref_sha256).not.toBe(otherReceipt.model.model_ref_sha256);
    const currentReport = inspectServeDoctor(db, path, { model_ref: firstModel, now: "2026-09-05T00:00:04Z" });
    const current = currentReport.model;
    expect(currentReport.failures.some(value => value.includes("field=predicate"))).toBe(true);
    expect(current.last_success_at).toBe("2026-09-05T00:00:03Z");
    expect(current.last_failure?.at).toBe("2026-09-05T00:00:01Z");
    expect(current.last_failure?.detail).toContain("field=predicate");
    const other = inspectServeDoctor(db, path, { model_ref: otherModel, now: "2026-09-05T00:00:04Z" }).model;
    expect(other.last_success_at).toBe("2026-09-05T00:00:02Z");
    expect(other.last_failure).toBeNull();
    const publicHistory = JSON.stringify([current, other, readFileSync(join(path, ".kizuki/run-receipts.jsonl"), "utf8")]);
    expect(publicHistory).not.toContain("deepseek-v4-flash-0731");
    expect(publicHistory).not.toContain("deepseek-v4-flash-0732");
  } finally { db.close(); }
});

test("already redacted historical references remain unattributed through republication", () => {
  const { path, db } = fixture();
  try {
    persistRunReceipt(db, path, { ...emptyRunTotals(), run_id: "legacy-redacted", rail: "sync", started_at: "2026-09-05T00:00:01Z", finished_at: "2026-09-05T00:00:01Z", status: "degraded", stopped: null,
      model: { ...emptyRunTotals().model, calls: 1, model_ref: "kizuki.llm.openai-compatible:deepseek/[redacted]@openrouter.ai", diagnostic } });
    const legacy = getRunReceipt(db, "legacy-redacted")!;
    expect(legacy.model.model_ref_sha256).toBeUndefined();
    pruneRunReceipts(db, path, "2026-09-01T00:00:00Z");
    expect(readFileSync(join(path, ".kizuki/run-receipts.jsonl"), "utf8")).not.toContain("model_ref_sha256");
    const doctor = inspectServeDoctor(db, path, { model_ref: "kizuki.llm.openai-compatible:deepseek/deepseek-v4-flash-0731@openrouter.ai", now: "2026-09-05T00:00:04Z" });
    expect(doctor.model.last_success_at).toBeNull();
    expect(doctor.model.last_failure).toBeNull();
    expect(doctor.model.unattributed_receipts).toBe(1);
    expect(doctor.model.detail).toContain("unattributed");
    expect(doctor.failures.some(value => value.includes("model history"))).toBe(true);
  } finally { db.close(); }
});
