import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { listCanonReceipts } from "../../src/canon/receipts";
import { worldCanonPath, worldClaimHandle } from "../../src/canon/world-materialization";
import { getClaim } from "../../src/claims/store";
import type { ProducerPort } from "../../src/contracts/producer";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { readExtractCursor } from "../../src/serve/extract";
import { runRail, runServeOnce, type RunRailOptions } from "../../src/serve/rails";
import { getRunReceipt, parseRunReceipt, recoverRunJournal, isNoopReceipt, coalesceNoopReceipt } from "../../src/serve/receipts";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { initServe, listSchedules } from "../../src/serve/schema";
import { registerWorldJobs } from "../../src/serve/world-jobs";
import { emptyRunTotals, InjectedCrash } from "../../src/serve/types";
import { runCanonWritePass, runWritePass } from "../../src/serve/write-pass";
import { listQuarantinedClaims, listQuarantinedPages, QUARANTINE_MS } from "../../src/serve/write-quarantine";
import { serializePage } from "../../src/vault/frontmatter";
import { canonFixture, putEvent, storeClaim, type CanonFixture } from "../canon/helpers";
import { eventFacts } from "../claims/helpers";
import { worldFixture } from "../serving/world-fixture";

const fixtures: CanonFixture[] = [];
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); for (const f of fixtures.splice(0)) f.dispose(); });
function fixture() { const f = canonFixture(); fixtures.push(f); return f; }
const forbidden = async (): Promise<never> => { throw new Error("fresh work must not run"); };
const producer: ProducerPort = {
  descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
  health: forbidden, produce: forbidden, close: async () => {},
};
function hooks(f: CanonFixture) {
  return { model_ref: "fixture/model", producer, claims: { db: f.db }, sync: forbidden, refresh: forbidden };
}
function options(f: CanonFixture) { return { ...hooks(f), budget: createBudgetTracker({ canon_writes_per_run: 8 }) }; }
const at = "2026-10-22T12:00:00.000Z";

function inputSnapshot(f: CanonFixture) {
  return {
    events: f.db.query("SELECT * FROM events ORDER BY event_id").all(),
    claims: f.db.query("SELECT claim_id,body,provenance,producer,model_ref FROM claims ORDER BY claim_id").all(),
    cursor: readExtractCursor(f.db),
    batches: f.db.query("SELECT * FROM extract_batches").all(),
  };
}

test("manual canon recovery writes both accepted claim codecs, preserves inputs and never runs fresh work", async () => {
  const f = fixture();
  const legacy = await storeClaim(f.db, putEvent(f.db));
  const world = await worldFixture(f.db);
  const before = inputSnapshot(f);
  let jobs = 0;
  disposers.push(registerWorldJobs([{ id: "canon-only-tripwire", run: () => { jobs++; throw new Error("world job must not run"); } }]));
  initServe(f.db);
  const schedules = listSchedules(f.db);
  let closed = 0;
  const receipt = await runRail(f.db, f.vault, "sync", {
    syncMode: "canon-only", now: () => at,
    acquireRuntime: async () => ({ hooks: hooks(f), close: async () => { closed++; } }),
  });
  expect(receipt).toMatchObject({ sync_mode: "canon-only", status: "ok", canon_writes: 2,
    events_synced: 0, claims_extracted: 0, model: { calls: 0, input_tokens: 0, output_tokens: 0, model_ref: "fixture/model" } });
  expect(receipt.consolidation).toBeUndefined();
  expect(receipt.schedule_transition).toBeUndefined();
  expect(closed).toBe(1);
  expect(jobs).toBe(0);
  expect(listSchedules(f.db)).toEqual(schedules);
  expect(inputSnapshot(f)).toEqual(before);
  expect(f.db.query("SELECT * FROM extract_usage").all()).toEqual([]);
  expect(getClaim(f.db, legacy.claim_id)?.receipt_id).toBeString();
  expect(world.claims.every(id => getClaim(f.db, id)?.receipt_id !== null)).toBe(true);
  expect(listCanonReceipts(f.db)).toHaveLength(2);
  expect(listCanonReceipts(f.db).every(r => r.writer === "loop")).toBe(true);
  expect(getRunReceipt(f.db, receipt.run_id)).toEqual(receipt);
  expect((await runRail(f.db, f.vault, "sync", { syncMode: "canon-only", hooks: hooks(f), now: () => at })).canon_writes).toBe(0);
  expect(listCanonReceipts(f.db)).toHaveLength(2);
});

test("missing model capabilities and a foreign ledger fail before new canon work", async () => {
  const f = fixture(), other = fixture();
  const claim = await storeClaim(f.db, putEvent(f.db));
  const full = options(f);
  const { producer: _producer, ...noProducer } = full;
  const { claims: _claims, ...noClaims } = full;
  for (const missing of [{ ...full, model_ref: null }, { ...full, model_ref: "" }, noProducer, noClaims]) {
    await expect(runCanonWritePass(f.db, f.vault, missing)).rejects.toThrow("requires a bound model");
  }
  await expect(runCanonWritePass(f.db, f.vault, { ...full, claims: { db: other.db } })).rejects.toThrow("ledger does not match");
  const receipt = await runRail(f.db, f.vault, "sync", { syncMode: "canon-only", hooks: { model_ref: "configured-name-only" } });
  expect(receipt).toMatchObject({ sync_mode: "canon-only", status: "failed", canon_writes: 0, model: { calls: 0 } });
  expect(getClaim(f.db, claim.claim_id)?.receipt_id).toBeNull();
  expect(listCanonReceipts(f.db)).toEqual([]);
});

test("non-sync, scheduled and once misuse is refused before runtime acquisition or rail initialization", async () => {
  const f = fixture(); let acquired = 0;
  const acquireRuntime = async () => { acquired++; return { hooks: hooks(f), close: async () => {} }; };
  const before = f.db.query("SELECT name FROM sqlite_master ORDER BY name").all();
  await expect(runRail(f.db, f.vault, "retrieval-sweep", { syncMode: "canon-only", acquireRuntime })).rejects.toThrow("only for manual sync");
  for (const trigger of ["scheduled", "once"] as const) {
    await expect(runRail(f.db, f.vault, "sync", { syncMode: "canon-only", acquireRuntime,
      execution: { instance_id: "fixture", pid: process.pid, boot_id: "fixture", trigger, due_at: at } })).rejects.toThrow("only for manual sync");
  }
  await expect(runServeOnce(f.db, f.vault, { rails: ["sync"], syncMode: "canon-only", acquireRuntime })).rejects.toThrow("only for manual sync");
  expect(acquired).toBe(0);
  expect(f.db.query("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual(before);
});

test("the ordinary sync default still extracts; no-model default still leaves canon unwritten", async () => {
  const f = fixture(); const claim = await storeClaim(f.db, putEvent(f.db)); let calls = 0;
  expect((await runWritePass(f.db, f.vault, { budget: createBudgetTracker({ canon_writes_per_run: 8 }) })).canon_writes).toBe(0);
  expect(getClaim(f.db, claim.claim_id)?.receipt_id).toBeNull();
  const extracting: ProducerPort = { ...producer,
    health: async () => ({ status: "ready", detail: {} }),
    produce: async () => { calls++; return { status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 }, dropped: [] }; },
  };
  const result = await runWritePass(f.db, f.vault, { ...options(f), producer: extracting });
  expect(calls).toBe(1); expect(result.model.calls).toBe(1); expect(result.canon_writes).toBe(1);
});

test("ordinary typed and legacy failure bookkeeping quarantines without replacing evidence or retrying a model", async () => {
  const f = fixture();
  const events = Array.from({ length: 101 }, () => putEvent(f.db));
  const legacy = await storeClaim(f.db, events[0]!, { kind: "entity", target: "topics/oversized", subject: "topic:oversized", subjects: ["topic:oversized"], predicate: null, object: null,
    frontmatter: { type: "topic", title: "Oversized evidence" }, provenance: events, events: events.map(id => eventFacts(id)) });
  const world = await worldFixture(f.db);
  const handle = worldClaimHandle(f.db, world.claims[0]!)!, path = worldCanonPath(handle);
  mkdirSync(dirname(join(f.vault, path)), { recursive: true });
  const bytes = serializePage({ data: { id: "topic:predecessor", type: "topic", status: "active", sensitivity: "private", taint: "quoted", sources: [] }, body: "Unrecorded predecessor." });
  writeFileSync(join(f.vault, path), bytes);
  const before = inputSnapshot(f);
  let clock = Date.parse(at);
  const pass = () => runCanonWritePass(f.db, f.vault, { ...options(f), now: () => new Date(clock).toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) { const report = await pass(); expect(report.errors).toHaveLength(attempt === 2 ? 4 : 2); clock += 60_000; }
  expect(listQuarantinedClaims(f.db, new Date(clock).toISOString()).claims).toHaveLength(1);
  expect(listQuarantinedPages(f.db, new Date(clock).toISOString())).toHaveLength(1);
  expect(getClaim(f.db, legacy.claim_id)?.receipt_id).toBeNull();
  expect(inputSnapshot(f)).toEqual(before);
  expect(readFileSync(join(f.vault, path), "utf8")).toBe(bytes);
  expect((await pass()).errors).toEqual([]);
  unlinkSync(join(f.vault, path));
  clock += QUARANTINE_MS;
  expect((await pass()).canon_writes).toBe(1);
  expect(listQuarantinedPages(f.db, new Date(clock).toISOString())).toEqual([]);
  expect(listQuarantinedClaims(f.db, new Date(clock).toISOString()).claims).toHaveLength(1);
}, 30_000);

test("revoked source authority, stop requests and write budget still constrain maintenance", async () => {
  const f = fixture();
  const world = await worldFixture(f.db);
  revokeSourceGrant(f.db, { source_key: world.sourceKey, expected_revision: 1, operation_id: "fixture-revoke" });
  const denied = await runCanonWritePass(f.db, f.vault, options(f));
  expect(denied.canon_writes).toBe(0);
  expect(world.claims.every(id => getClaim(f.db, id)?.receipt_id === null)).toBe(true);
  const other = fixture(); const claim = await storeClaim(other.db, putEvent(other.db));
  expect((await runCanonWritePass(other.db, other.vault, { ...options(other), stopRequested: () => true })).stopped).toBe("serve:stop_requested");
  const zero = await runCanonWritePass(other.db, other.vault, { ...options(other), budget: createBudgetTracker({ canon_writes_per_run: 0 }) });
  expect(zero.canon_writes).toBe(0);
  expect(getClaim(other.db, claim.claim_id)?.receipt_id).toBeNull();
});

test("journal interruption preserves the maintenance marker and replays without a second write or schedule advance", async () => {
  const f = fixture(); await storeClaim(f.db, putEvent(f.db)); initServe(f.db);
  const schedule = listSchedules(f.db);
  await expect(runRail(f.db, f.vault, "sync", { syncMode: "canon-only", hooks: hooks(f), now: () => at, crashAfter: "after-jsonl" })).rejects.toBeInstanceOf(InjectedCrash);
  expect(listCanonReceipts(f.db)).toHaveLength(1);
  recoverRunJournal(f.db, f.vault);
  expect(listSchedules(f.db)).toEqual(schedule);
  const stored = JSON.parse(readFileSync(join(f.vault, ".kizuki/run-receipts.jsonl"), "utf8").trim());
  const receipt = getRunReceipt(f.db, stored.run_id)!;
  expect(receipt.sync_mode).toBe("canon-only");
  expect(receipt.schedule_transition).toBeUndefined();
  expect(parseRunReceipt(receipt)).toEqual(receipt);
  expect(() => parseRunReceipt({ ...receipt, sync_mode: "something-else" })).toThrow("invalid receipt sync mode");
  expect(() => parseRunReceipt({ ...receipt, rail: "doctor-sweep" })).toThrow("invalid receipt sync mode");
  expect(() => parseRunReceipt({ ...receipt, execution: { ...receipt.execution!, trigger: "scheduled" } })).toThrow("invalid receipt sync mode");
  expect((await runRail(f.db, f.vault, "sync", { syncMode: "canon-only", hooks: hooks(f), now: () => at })).canon_writes).toBe(0);
});


test("maintenance cannot hide failed full sync, postpone its slot or coalesce its next success", async () => {
  const f = fixture();
  const failed = await runRail(f.db, f.vault, "sync", { now: () => at, hooks: { sync: async () => { throw new Error("capture failed"); } } });
  expect(failed.status).toBe("failed");
  const before = listSchedules(f.db);
  const maintained = await runRail(f.db, f.vault, "sync", { syncMode: "canon-only", hooks: hooks(f), now: () => "2026-10-22T12:01:00.000Z" });
  expect(maintained.status).toBe("ok");
  expect(isNoopReceipt(maintained)).toBe(false);
  expect(listSchedules(f.db)).toEqual(before);
  const doctor = inspectServeDoctor(f.db, f.vault, { now: "2026-10-22T12:01:01.000Z" });
  expect(doctor.rails.find(r => r.rail === "sync")?.last_result).toBe("failed");
  expect(doctor.rails.find(r => r.rail === "sync")?.reason).toContain("capture failed");
  const { sync_mode: _mode, ...ordinary } = maintained;
  const scheduled = { ...ordinary, run_id: "fixture-next-sync", execution: { ...ordinary.execution!, trigger: "scheduled" as const, due_at: "2026-10-22T12:15:00.000Z" } };
  expect(coalesceNoopReceipt(f.db, f.vault, scheduled)).toBe(false);
});


test("an interrupted answered model attempt is reconciled separately without another request", async () => {
  const f = fixture(); initServe(f.db);
  const schedule = listSchedules(f.db);
  const metrics = { model: { ...emptyRunTotals().model, calls: 1, input_tokens: 12, output_tokens: 4 }, claims_extracted: 1, claims_rejected: {} };
  f.db.query("INSERT INTO extract_usage(run_id,model_ref,metrics,created_at,holder_pid) VALUES (?,?,?,?,?)")
    .run("fixture-interrupted-run", "fixture/prior-model", JSON.stringify(metrics), at, process.pid);
  const receipt = await runRail(f.db, f.vault, "sync", { syncMode: "canon-only", hooks: hooks(f), now: () => at });
  expect(receipt).toMatchObject({ sync_mode: "canon-only", status: "ok", claims_extracted: 0, model: { calls: 0 } });
  const interrupted = getRunReceipt(f.db, "fixture-interrupted-run")!;
  expect(interrupted).toMatchObject({ status: "failed", claims_extracted: 1, model: { calls: 1, input_tokens: 12, output_tokens: 4, model_ref: "fixture/prior-model" } });
  expect(listSchedules(f.db)).toEqual(schedule);
  expect(interrupted.sync_mode).toBeUndefined();
  expect(interrupted.errors).toEqual(["sync interrupted after model decision"]);
  expect(f.db.query("SELECT * FROM extract_usage").all()).toEqual([]);
});


test("runtime acquisition cannot mutate manual recovery into fresh sync work", async () => {
  const f = fixture(); await storeClaim(f.db, putEvent(f.db));
  const execution = { instance_id: "fixture-mutation", pid: process.pid, boot_id: "fixture", trigger: "manual" as "manual" | "scheduled", due_at: null };
  const request: { -readonly [K in keyof RunRailOptions]: RunRailOptions[K] } = {
    syncMode: "canon-only", execution,
    acquireRuntime: async () => {
      delete request.syncMode;
      execution.trigger = "scheduled";
      return { hooks: hooks(f), close: async () => {} };
    },
  };
  const receipt = await runRail(f.db, f.vault, "sync", request);
  expect(receipt).toMatchObject({ sync_mode: "canon-only", status: "ok", canon_writes: 1, model: { calls: 0 }, execution: { trigger: "manual" } });
  expect(receipt.schedule_transition).toBeUndefined();
});
