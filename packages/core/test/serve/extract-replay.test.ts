import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { exportVault, restoreVault } from "../../src/export";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { bindSourceModelPort, revokeSourceGrant, setSourceGrant, sourcePolicyEpoch } from "../../src/ledger/source-grants";
import { accept } from "../../src/ledger/ledger";
import { registerConnection } from "../../src/ledger/connections";
import { writeRailCursor } from "../../src/ledger/checkpoints";
import { EXTRACT_BATCH, MODEL_PRODUCER_ID } from "../../src/producer";
import { validEvent } from "../fixtures";
import { modelProducerFingerprint } from "../../src/producer/fingerprint";
import { activeExtractReplay, parseEmptySegmentReplayPlan, parseEmptySegmentReplaySupersessionPlan, replayEmptyExtractSegment } from "../../src/serve/extract-replay";
import { applyExtractReplay } from "../../src/serve/extract-replay-schema";
import { commitExtractCursor, journalExtractBatch, mineLiveDrafts, readExtractCursor } from "../../src/serve/extract";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { readRejections } from "../../src/serve/extract-rejections";
import { runRail } from "../../src/serve/rails";
import { registerWorldJobs } from "../../src/serve/world-jobs";
import { withVaultMutationSync } from "../../src/vault/mutation-scope";
import { canonicalJson, sha256Hex } from "../../src/util/hash";
import { storeClaim } from "../canon/helpers";
import { replayFixture } from "./extract-replay-fixture";
import { ENDPOINT, MODEL, recordText, writeServeToml } from "./throughput-fixture";

const fixtures: ReturnType<typeof replayFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
function fixture(...args: Parameters<typeof replayFixture>) { const f = replayFixture(...args); fixtures.push(f); return f; }
const apply = (f: ReturnType<typeof fixture>, plan: unknown = f.plan) => replayEmptyExtractSegment({ db: f.db, vault_path: f.vault, producer: f.producer }, plan);
const progress = (f: ReturnType<typeof fixture>) => f.db.query<Record<string, unknown>, []>("SELECT * FROM extract_oversized_records").all();
const stable = (f: ReturnType<typeof fixture>) => Object.fromEntries(["events", "claims", "rail_cursors", "extract_deferred_inputs", "run_receipts"].map(table =>
  [table, f.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test("metadata-only apply is atomic, idempotent and does not rewrite the ledger, cursor, inputs or historical receipts", () => {
  const f = fixture(), before = stable(f);
  const accepted = apply(f);
  expect(accepted.status).toBe("accepted");
  expect(progress(f)).toMatchObject([{ done_utf16: 0, pending_end_utf16: null, replay_operation_id: f.plan.operation_id }]);
  expect(stable(f)).toEqual(before);
  expect(f.calls).toEqual([]);
  f.db.query("UPDATE extract_oversized_records SET done_utf16=100").run();
  expect(apply(f)).toEqual({ ...accepted, status: "already_applied" });
  expect(progress(f)).toMatchObject([{ done_utf16: 100 }]);
  expect(() => apply(f, { ...f.plan, new_review_sha256: "e".repeat(64) })).toThrow("replay_conflict");
  expect(f.db.query("SELECT * FROM leases").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toHaveLength(1);
});

test("closed plan refuses unknown fields, invalid bounds, equal fingerprints and absent historical attestation", () => {
  const f = fixture();
  for (const value of [{ ...f.plan, extra: true }, { ...f.plan, historical_evidence: true },
    { ...f.plan, new_producer_fingerprint: f.plan.old_producer_fingerprint }, { ...f.plan, segment: { ...f.plan.segment, done_utf16: 0 } }]) {
    expect(() => parseEmptySegmentReplayPlan(value)).toThrow("invalid_plan");
  }
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
  let reads = 0;
  expect(() => parseEmptySegmentReplayPlan({ ...f.plan, get source_epoch() { reads++; return 1; } })).toThrow("invalid_plan");
  expect(reads).toBe(0);
});

test("v2 supersession plan is closed, strictly advances parent progress, and retains v1 parsing", () => {
  const f = fixture();
  const parent = { operation_id: f.plan.operation_id, plan_sha256: sha256Hex(canonicalJson(f.plan)), current_done_utf16: 7,
    current_updated_at: "2026-10-22T08:01:00.000Z", settlements_sha256: sha256Hex("settlements"), run_receipts_sha256: sha256Hex("runs") };
  const plan = { ...f.plan, schema: "kizuki.extract-empty-replay/v2" as const, operation_id: "synthetic-replay-2",
    new_producer_fingerprint: "a".repeat(64), parent };
  expect(parseEmptySegmentReplayPlan(f.plan)).toEqual(f.plan);
  expect(parseEmptySegmentReplaySupersessionPlan(plan)).toEqual(plan);
  for (const patch of [{ extra: true }, { parent: { ...parent, current_done_utf16: f.plan.segment.done_utf16 } },
    { parent: { ...parent, operation_id: plan.operation_id } }, { parent: { ...parent, settlements_sha256: "bad" } }]) {
    expect(() => parseEmptySegmentReplaySupersessionPlan({ ...plan, ...patch })).toThrow("invalid_plan");
  }
});

test("exact live identities, consent, cursor and settled bounds are compared before any reset", () => {
  for (const patch of [{ content_hash: "e".repeat(64) }, { text_hash: "e".repeat(64) }, { source_revision: 2 },
    { source_key: "other-source" }, { source_epoch: 999 }, { model_binding_digest: "e".repeat(64) },
    { new_producer_fingerprint: "e".repeat(64) }, { expected_cursor: "changed" }, { old_run_receipt_sha256: "e".repeat(64) }]) {
    const f = fixture(), before = progress(f);
    expect(() => apply(f, { ...f.plan, ...patch })).toThrow();
    expect(progress(f)).toEqual(before);
    expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
  }
});

test("writer contention, pending usage, changed segment and historical nonempty counters refuse without cleanup", () => {
  const f = fixture(), before = progress(f);
  withVaultMutationSync({ db: f.db, vault_path: f.vault }, () => expect(() => apply(f)).toThrow("busy"));
  f.db.query("INSERT INTO extract_usage VALUES('pending',NULL,'{}',1,'2026-10-22T00:00:00Z')").run();
  expect(() => apply(f)).toThrow("unsettled_work");
  expect(f.db.query("SELECT * FROM extract_usage").all()).toHaveLength(1);
  f.db.query("DELETE FROM extract_usage").run();
  f.db.query("UPDATE extract_oversized_records SET pending_end_utf16=done_utf16+1").run();
  expect(() => apply(f)).toThrow("segment_changed");
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
  f.db.query("UPDATE extract_oversized_records SET pending_end_utf16=NULL").run();
  expect(progress(f)).toEqual(before);
  f.db.query("UPDATE run_receipts SET report=json_set(report,'$.claims_extracted',1)").run();
  expect(() => apply(f)).toThrow("historical_evidence_invalid");
});

test("any-status legacy model support refuses replay, including superseded and rejected claims", async () => {
  for (const status of ["live", "superseded", "skipped", "purged"]) {
    const f = fixture();
    const claim = await storeClaim(f.db, f.event.event_id, { producer: "model", model_ref: MODEL });
    f.db.query("UPDATE claims SET status=? WHERE claim_id=?").run(status, claim.claim_id);
    expect(() => apply(f)).toThrow("claims_present");
    expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
  }
});

test("CAS failure rolls back its receipt and releases the writer", () => {
  const f = fixture(), before = progress(f);
  f.db.exec("CREATE TRIGGER fixture_block_reset BEFORE UPDATE OF done_utf16 ON extract_oversized_records BEGIN SELECT RAISE(IGNORE); END");
  expect(() => apply(f)).toThrow("segment_changed");
  expect(progress(f)).toEqual(before);
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM leases").all()).toEqual([]);
});

test("actual built-in producer identity cannot be supplied by a port property, mutated method or closed port", async () => {
  const f = fixture();
  expect(modelProducerFingerprint({ ...f.producer, fingerprint: f.plan.new_producer_fingerprint })).toBeNull();
  expect(Object.isFrozen(f.producer)).toBe(true);
  expect(Object.isFrozen(f.producer.descriptor)).toBe(true);
  expect(() => { f.producer.produce = async () => { throw new Error("spoof"); }; }).toThrow();
  expect(Reflect.set(f.producer, "descriptor", { ...f.producer.descriptor, contract: "kizuki.producer/v1" })).toBe(false);
  expect(modelProducerFingerprint(f.producer)).toBe(f.plan.new_producer_fingerprint);
  await f.producer.close();
  expect(() => apply(f)).toThrow("producer_changed");
});

test("ordinary empty replay uses smaller legal segments, audits them, and stops at the old end without touching the remainder", async () => {
  const f = fixture(); apply(f);
  const old = f.plan.segment.done_utf16;
  let syncs = 0;
  const sync = async () => { syncs++; return { events_synced: 0, events_stored: 0, events_duplicate: 0, events_self_skipped: 0, errors: [] }; };
  const result = await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL, sync } });
  expect(result.stopped).toBe("extract:replay_complete");
  expect(syncs).toBe(0);
  expect(result).toMatchObject({ events_synced: 0, events_stored: 0, events_duplicate: 0, events_self_skipped: 0 });
  expect(f.calls.length).toBeGreaterThan(1);
  expect(f.calls.join("")).toBe(f.event.text.slice(0, old));
  expect(progress(f)).toMatchObject([{ done_utf16: old, replay_operation_id: null }]);
  expect(readExtractCursor(f.db)).toBe(f.plan.expected_cursor);
  expect(result.claims_extracted).toBe(0);
  const settled = f.db.query<{ outcome: string; producer_fingerprint: string; replay_operation_id: string }, []>("SELECT * FROM extract_segment_settlements ORDER BY start_utf16").all();
  expect(settled).toHaveLength(f.calls.length);
  expect(settled.every(row => row.outcome === "empty" && row.producer_fingerprint === f.plan.new_producer_fingerprint && row.replay_operation_id === f.plan.operation_id)).toBe(true);
  expect(apply(f).status).toBe("already_applied");
  expect(progress(f)).toMatchObject([{ done_utf16: old }]);
  const backup = join(f.root, "settled-backup"), restored = join(f.root, "settled-restored");
  exportVault(f.db, f.vault, backup); restoreVault(backup, restored);
  const copy = openLedger(join(restored, ".kizuki/kizuki.db"));
  try { expect(copy.query("SELECT * FROM extract_segment_settlements ORDER BY start_utf16").all()).toEqual(settled); }
  finally { copy.close(); }
  await runRail(f.db, f.vault, "sync", { hooks: { sync } });
  expect(syncs).toBe(1);
});

test("active replay refuses missing, wrong or stale producer state before capture", async () => {
  for (const label of ["missing", "wrong", "stale"] as const) {
    const f = fixture(); apply(f);
    const producer = label === "missing" ? undefined : label === "wrong" ? { ...f.producer } : f.producer;
    if (label === "stale") {
      revokeSourceGrant(f.db, { source_key: f.plan.source_key, expected_revision: 1, operation_id: "stale-before-capture" });
    }
    let syncs = 0;
    const result = await runRail(f.db, f.vault, "sync", { hooks: {
      ...(producer === undefined ? {} : { producer }),
      model_ref: MODEL,
      sync: async () => { syncs++; throw new Error(`capture ran for ${label}`); },
    } });
    expect(syncs).toBe(0);
    expect(f.calls).toEqual([]);
    expect(result.status).toBe("stopped");
    expect(result.stopped).toBe(label === "stale" ? "extract:source_changed" : "extract:producer_changed");
    expect(result).toMatchObject({ events_synced: 0, events_stored: 0, events_duplicate: 0, events_self_skipped: 0 });
    expect(result.model.model_ref).not.toBeNull();
  }
});

test("partial, rejected and stopped replay passes keep capture suppressed", async () => {
  const partial = fixture(); apply(partial);
  writeServeToml(partial.vault, '[extraction]\nmax_calls_per_pass=1\nmax_input_tokens=5000\n');
  let partialSyncs = 0;
  const partialHooks = { producer: partial.producer, claims: { db: partial.db }, model_ref: MODEL,
    sync: async () => { partialSyncs++; throw new Error("capture ran during partial replay"); } };
  await runRail(partial.db, partial.vault, "sync", { hooks: partialHooks });
  expect(activeExtractReplay(partial.db, partial.event.event_id, partial.producer)).not.toBeNull();
  await runRail(partial.db, partial.vault, "sync", { hooks: partialHooks });
  expect(partialSyncs).toBe(0);

  const rejected = fixture("rejected"); apply(rejected);
  let rejectedSyncs = 0;
  const rejectedResult = await runRail(rejected.db, rejected.vault, "sync", { hooks: { producer: rejected.producer,
    claims: { db: rejected.db }, model_ref: MODEL,
    sync: async () => { rejectedSyncs++; throw new Error("capture ran during rejected replay"); } } });
  expect(rejectedResult.stopped).toBe("extract:replay_rejected");
  expect(rejectedSyncs).toBe(0);
  expect(activeExtractReplay(rejected.db, rejected.event.event_id, rejected.producer)).not.toBeNull();

  const stopped = fixture(); apply(stopped);
  let stoppedSyncs = 0;
  const stoppedResult = await runRail(stopped.db, stopped.vault, "sync", { stopRequested: () => true, hooks: {
    producer: stopped.producer, claims: { db: stopped.db }, model_ref: MODEL,
    sync: async () => { stoppedSyncs++; throw new Error("capture ran during stopped replay"); } } });
  expect(stoppedResult.stopped).toBe("serve:stop_requested");
  expect(stoppedSyncs).toBe(0);
  expect(stopped.calls).toEqual([]);
});

test("a replay that spends all eight calls remains partial until its exact historical cap settles", async () => {
  const f = fixture(); apply(f);
  // A deliberately smaller request budget still needs more than this pass's
  // eight calls. Completion must describe settled progress, never the call cap.
  writeServeToml(f.vault, '[extraction]\nmax_calls_per_pass=8\nmax_input_tokens=5000\n');
  const hooks = { producer: f.producer, claims: { db: f.db }, model_ref: MODEL };
  const partial = await runRail(f.db, f.vault, "sync", { hooks });
  const done = Number(progress(f)[0]!.done_utf16);
  expect(partial.stopped).toBeNull();
  expect(partial.model.calls).toBe(8);
  expect(done).toBeGreaterThan(0);
  expect(done).toBeLessThan(f.plan.segment.done_utf16);
  expect(f.calls.join("")).toBe(f.event.text.slice(0, done));
  expect(activeExtractReplay(f.db, f.event.event_id, f.producer)).not.toBeNull();
  expect(readExtractCursor(f.db)).toBe(f.plan.expected_cursor);
  const completed = await runRail(f.db, f.vault, "sync", { hooks });
  expect(completed.stopped).toBe("extract:replay_complete");
  expect(f.calls.join("")).toBe(f.event.text.slice(0, f.plan.segment.done_utf16));
  expect(progress(f)).toMatchObject([{ done_utf16: f.plan.segment.done_utf16, replay_operation_id: null }]);
});

test("nonempty replay goes through ordinary claims and canon writer and stops at the same old end", async () => {
  const f = fixture("nonempty"); apply(f);
  const result = await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
  expect(result.stopped).toBe("extract:replay_complete");
  expect(result.claims_extracted).toBeGreaterThan(0);
  expect(f.calls.join("")).toBe(f.event.text.slice(0, f.plan.segment.done_utf16));
  expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM claims").all().length).toBeGreaterThan(0);
  expect(f.db.query<{ outcome: string; replay_operation_id: string }, []>("SELECT outcome,replay_operation_id FROM extract_segment_settlements").all())
    .toEqual(f.calls.map(() => ({ outcome: "nonempty", replay_operation_id: f.plan.operation_id })));
  expect(readExtractCursor(f.db)).toBe(f.plan.expected_cursor);
  const backup = join(f.root, "nonempty-backup"), restored = join(f.root, "nonempty-restored");
  exportVault(f.db, f.vault, backup); restoreVault(backup, restored);
  const copy = openLedger(join(restored, ".kizuki/kizuki.db"));
  try { expect(copy.query("SELECT * FROM extract_segment_settlements ORDER BY start_utf16").all())
    .toEqual(f.db.query("SELECT * FROM extract_segment_settlements ORDER BY start_utf16").all()); }
  finally { copy.close(); }
});

test("rejected replay retains the reset checkpoint and never skips or resamples it in that pass", async () => {
  const f = fixture("rejected"); apply(f);
  const result = await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
  expect(result.stopped).toBe("extract:replay_rejected");
  expect(f.calls).toHaveLength(1);
  expect(readRejections(f.db, new Date().toISOString())).toMatchObject({ consecutive: 1, narrow: f.event.event_id });
  expect(progress(f)).toMatchObject([{ status: "segmenting", done_utf16: 0, replay_operation_id: f.plan.operation_id }]);
});

test("malformed but valid JSON model provenance is not evidence of a disjoint historical claim", async () => {
  for (const provenance of ["{}", "[]", '"unlocated"', '["invalid-id"]']) {
    const f = fixture();
    const claim = await storeClaim(f.db, f.event.event_id, { producer: "model", model_ref: MODEL });
    f.db.query("UPDATE claims SET provenance=? WHERE claim_id=?").run(provenance, claim.claim_id);
    expect(() => apply(f)).toThrow("claims_present");
    expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
  }
});

test("a larger budget cannot bypass the replay cap and an unfit budget cannot skip it", async () => {
  const large = fixture(); apply(large);
  writeServeToml(large.vault, '[extraction]\nmax_calls_per_pass=8\nmax_input_tokens=100000\n');
  const mined = await mineLiveDrafts(large.db, large.producer, { ...DEFAULT_EXTRACTION_CONFIG, max_input_tokens: 100000 });
  expect(mined.segment).toMatchObject({ start: 0, end: large.plan.segment.done_utf16 });
  expect(large.calls).toEqual([large.event.text.slice(0, large.plan.segment.done_utf16)]);
  const small = fixture(); apply(small);
  const refused = await mineLiveDrafts(small.db, small.producer, { ...DEFAULT_EXTRACTION_CONFIG, max_input_tokens: 1 });
  expect(refused.mined.status).toBe("unavailable");
  expect(refused.skipped).toBeUndefined();
  expect(small.calls).toEqual([]);
  expect(progress(small)).toMatchObject([{ status: "segmenting", done_utf16: 0, replay_operation_id: small.plan.operation_id }]);
});

test("revocation before or during a request never advances, defers, settles or files the replay", async () => {
  const before = fixture(); apply(before);
  revokeSourceGrant(before.db, { source_key: before.plan.source_key, expected_revision: 1, operation_id: "before-replay-revoke" });
  const result = await runRail(before.db, before.vault, "sync", { hooks: { producer: before.producer, claims: { db: before.db }, model_ref: MODEL } });
  expect(result.stopped).toBe("extract:source_changed");
  expect(before.calls).toEqual([]);
  expect(progress(before)).toMatchObject([{ done_utf16: 0 }]);
  expect(readExtractCursor(before.db)).toBe(before.plan.expected_cursor);
  const during = fixture("empty", () => revokeSourceGrant(during.db, { source_key: during.plan.source_key, expected_revision: 1, operation_id: "during-replay-revoke" }));
  apply(during);
  await runRail(during.db, during.vault, "sync", { hooks: { producer: during.producer, claims: { db: during.db }, model_ref: MODEL } });
  expect(during.calls).toHaveLength(1);
  expect(progress(during)).toMatchObject([{ done_utf16: 0, pending_end_utf16: null }]);
  expect(during.db.query("SELECT * FROM extract_segment_settlements").all()).toEqual([]);
  expect(during.db.query("SELECT * FROM claims").all()).toEqual([]);
});

test("a journaled final replay segment survives reopening and files once without another model request", async () => {
  const f = fixture("nonempty"); apply(f);
  const mined = await mineLiveDrafts(f.db, f.producer, { ...DEFAULT_EXTRACTION_CONFIG, max_input_tokens: 100000 });
  expect(mined.segment?.end).toBe(f.plan.segment.done_utf16);
  journalExtractBatch(f.db, mined, MODEL, f.producer);
  expect(progress(f)).toMatchObject([{ done_utf16: 0, pending_end_utf16: f.plan.segment.done_utf16 }]);
  const reopened = openLedger(f.ledger);
  try {
    const result = await runRail(reopened, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: reopened }, model_ref: MODEL } });
    expect(result.stopped).toBe("extract:replay_complete");
    expect(f.calls).toHaveLength(1);
    expect(progress(f)).toMatchObject([{ done_utf16: f.plan.segment.done_utf16, replay_operation_id: null, pending_end_utf16: null }]);
    expect(reopened.query("SELECT * FROM claims").all()).toHaveLength(1);
    expect(reopened.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(reopened.query("SELECT outcome,replay_operation_id FROM extract_segment_settlements").all())
      .toEqual([{ outcome: "nonempty", replay_operation_id: f.plan.operation_id }]);
  } finally { reopened.close(); }
});

test("replay ignores unrelated deferred work and skips other world jobs", async () => {
  const f = fixture("empty", () => {}, 2); apply(f);
  f.db.query("INSERT INTO extract_deferred_inputs VALUES(?,?,0,?)").run(f.eventIds[1]!, f.plan.source_key, "0".repeat(64));
  const queued = f.db.query("SELECT * FROM extract_deferred_inputs").all();
  let jobs = 0;
  const unregister = registerWorldJobs([{ id: "synthetic-replay-isolation", run: () => { jobs++; } }]);
  try {
    const result = await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
    expect(result.stopped).toBe("extract:replay_complete");
    expect(f.calls.join("")).toBe(f.event.text.slice(0, f.plan.segment.done_utf16));
    expect(f.calls.length).toBeGreaterThan(0);
    expect(jobs).toBe(0);
    expect(f.db.query("SELECT * FROM extract_deferred_inputs").all()).toEqual(queued);
    expect(progress(f)).toMatchObject([{ done_utf16: f.plan.segment.done_utf16, replay_operation_id: null }]);
    const ready = fixture(); apply(ready);
    const finished = await runRail(ready.db, ready.vault, "sync", { hooks: { producer: ready.producer, claims: { db: ready.db }, model_ref: MODEL } });
    expect(finished.stopped).toBe("extract:replay_complete");
    expect(jobs).toBe(0);
    await runRail(ready.db, ready.vault, "sync");
    expect(jobs).toBe(1);
  } finally { unregister(); }
});

for (const changed of ["missing", "denied", "frontier-order", "deferred-binding"] as const) test(`isolated replay refuses a changed ${changed} target without maintaining other queue rows`, async () => {
  const f = fixture("empty", () => {}, 2);
  if (changed === "frontier-order") {
    // A valid later replay target cannot skip the original unprocessed frontier.
    // Capture it normally: event origin and accepted-at bindings stay immutable.
    const later = accept(f.db, { ...validEvent(), connector_id: f.event.connector_id, source_record_id: "later-replay-target", text: f.event.text, subjects: [] },
      { source: { source_key: f.plan.source_key, expected_revision: 1 } });
    if (later.status !== "stored") throw new Error("synthetic later replay capture failed");
    f.db.query("UPDATE extract_oversized_records SET event_id=? WHERE event_id=?").run(later.event.event_id, f.event.event_id);
    apply(f, { ...f.plan, event_id: later.event.event_id, content_hash: later.event.content_hash, text_hash: later.event.text_hash });
  } else apply(f);
  f.db.query("INSERT INTO extract_deferred_inputs VALUES(?,?,0,?)").run(f.eventIds[1]!, f.plan.source_key, "0".repeat(64));
  if (changed === "missing") f.db.query("UPDATE events SET deleted=1 WHERE event_id=?").run(f.event.event_id);
  else if (changed === "denied") revokeSourceGrant(f.db, { source_key: f.plan.source_key, expected_revision: 1, operation_id: "isolated-replay-denied" });
  else if (changed === "deferred-binding") f.db.query("INSERT INTO extract_deferred_inputs VALUES(?,NULL,0,?)").run(f.event.event_id, "0".repeat(64));
  const rows = f.db.query("SELECT rowid,* FROM extract_deferred_inputs ORDER BY event_id").all();
  const cursors = f.db.query("SELECT rowid,* FROM rail_cursors ORDER BY rail,source_key").all();
  const result = await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
  expect(result.stopped).toBe(changed === "missing" || changed === "denied" ? "extract:source_changed" : "extract:segment_changed");
  expect(f.calls).toEqual([]);
  expect(f.db.query("SELECT rowid,* FROM extract_deferred_inputs ORDER BY event_id").all()).toEqual(rows);
  expect(f.db.query("SELECT rowid,* FROM rail_cursors ORDER BY rail,source_key").all()).toEqual(cursors);
  expect(f.db.query("SELECT * FROM extract_segment_settlements").all()).toEqual([]);
});

for (const queuedTarget of [false, true]) for (const reply of ["empty", "nonempty"] as const) test(`active ${reply} ${queuedTarget ? "deferred" : "frontier"} replay leaves stale unrelated deferred pages and both cursors byte-identical`, async () => {
  const f = fixture(reply, () => {}, EXTRACT_BATCH + 3), held = "01J00000000000000000000HVD";
  registerConnection(f.db, "kizuki.fixture", held);
  setSourceGrant(f.db, { source_key: held, expected_revision: 0, operation_id: "replay-isolation-denied", policy: {
    purposes: ["capture", "recall", "derive", "extract"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
  } });
  const insert = f.db.query("INSERT INTO extract_deferred_inputs VALUES(?,?,0,?)");
  for (const id of f.eventIds.slice(queuedTarget ? 0 : 1)) insert.run(id, f.plan.source_key, "0".repeat(64));
  for (let index = 0; index < EXTRACT_BATCH + 3; index++) {
    const captured = accept(f.db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: `isolation-denied-${index}`, text: recordText(index), subjects: [] },
      { source: { source_key: held, expected_revision: 1 } });
    if (captured.status !== "stored") throw new Error("synthetic isolation capture failed");
    insert.run(captured.event.event_id, held, "0".repeat(64));
  }
  // Start after the allowed page so ordinary maintenance first refreshes denied hints and rotates its scan.
  writeRailCursor(f.db, MODEL_PRODUCER_ID, "extract-deferred-scan", f.eventIds.at(-1)!);
  apply(f, { ...f.plan, source_epoch: sourcePolicyEpoch(f.db) });
  const rows = () => f.db.query("SELECT rowid,* FROM extract_deferred_inputs ORDER BY event_id").all();
  const cursors = () => f.db.query("SELECT rowid,* FROM rail_cursors ORDER BY rail,source_key").all();
  const beforeRows = rows(), beforeCursors = cursors();
  expect(beforeRows.length).toBeGreaterThan(EXTRACT_BATCH * 2);
  const result = await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
  expect(rows()).toEqual(beforeRows);
  expect(cursors()).toEqual(beforeCursors);
  expect(result.stopped).toBe("extract:replay_complete");
  expect(f.calls.join("")).toBe(f.event.text.slice(0, f.plan.segment.done_utf16));
  expect(f.calls.length).toBeGreaterThan(0);
  expect(result.claims_extracted > 0).toBe(reply === "nonempty");
  expect(f.db.query("SELECT * FROM extract_segment_settlements").all()).toHaveLength(f.calls.length);
  // Once the replay is over, ordinary extraction still refreshes denied hints and selects allowed deferred work.
  const ordinary = await mineLiveDrafts(f.db, f.producer);
  expect(ordinary.mode).toBe("deferred");
  expect(rows()).not.toEqual(beforeRows);
  expect(f.db.query<{n:number},[string]>("SELECT count(*) n FROM extract_deferred_inputs WHERE source_key=? AND checked_revision=1").get(held)!.n).toBeGreaterThan(0);
});

test("schema47 upgrade preserves source/checkpoints and source purge cascades replay metadata", () => {
  const f = fixture(), before = stable(f), oldProgress = progress(f).map(({ replay_operation_id: _ignored, ...row }) => row);
  f.db.exec("DROP TRIGGER extract_replay_source_erased; ALTER TABLE extract_oversized_records DROP COLUMN replay_operation_id; DROP TABLE extract_segment_settlements; DROP TABLE extract_replay_receipts; UPDATE schema_version SET version=47");
  const upgraded = openLedger(f.ledger);
  try {
    expect(upgraded.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
    expect(stable(f)).toEqual(before);
    expect(progress(f)).toEqual(oldProgress.map(row => ({ ...row, replay_operation_id: null })));
    apply(f);
    // Exercise the exact source-erasure SQL transition used by its supported controller.
    f.db.query("UPDATE source_grants SET status='purged' WHERE source_key=?").run(f.plan.source_key);
    expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM extract_segment_settlements").all()).toEqual([]);
    expect(progress(f)).toMatchObject([{ replay_operation_id: null }]);
  } finally { upgraded.close(); }
});

test("policy revocation and changed producer binding after preparation prevent a request", () => {
  const f = fixture(); apply(f);
  expect(() => bindSourceModelPort(f.producer, { model_endpoint: ENDPOINT, model: "changed-model" })).toThrow("source_model_binding_conflict");
  revokeSourceGrant(f.db, { source_key: f.plan.source_key, expected_revision: 1, operation_id: "replay-revoke" });
  expect(() => activeExtractReplay(f.db, f.event.event_id, f.producer)).toThrow();
  expect(f.calls).toEqual([]);
});

test("migration is idempotent and export/restore preserves receipt, active cap and supported physical purge removes them", () => {
  const f = fixture(); apply(f);
  applyExtractReplay(f.db); applyExtractReplay(f.db);
  const backup = join(f.root, "backup"), restored = join(f.root, "restored");
  exportVault(f.db, f.vault, backup);
  restoreVault(backup, restored);
  const db = openLedger(join(restored, ".kizuki/kizuki.db"));
  try {
    expect(db.query("SELECT * FROM extract_replay_receipts").all()).toEqual(f.db.query("SELECT * FROM extract_replay_receipts").all());
    expect(db.query("SELECT * FROM extract_oversized_records").all()).toEqual(progress(f));
  } finally { db.close(); }
  purgeEvents(f.db, f.vault, { event_id: f.event.event_id }, "synthetic replay purge");
  expect(progress(f)).toEqual([]);
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM extract_segment_settlements").all()).toEqual([]);
});

function rewriteHistorical(f: ReturnType<typeof fixture>, patch: Record<string, unknown>) {
  const row = f.db.query<{ report: string }, []>("SELECT report FROM run_receipts").get()!;
  const original: Record<string, unknown> = JSON.parse(row.report);
  const report = JSON.stringify({ ...original, ...patch });
  f.db.query("UPDATE run_receipts SET report=?,status=?,stopped=?").run(report, String(patch.status ?? original.status), patch.stopped == null ? null : String(patch.stopped));
  return { ...f.plan, old_run_receipt_sha256: sha256Hex(report) };
}

test("a separately attested capture denial may degrade an otherwise clean empty extraction with unrelated canon writes", () => {
  const f = fixture(), errors = ["synthetic previously purged canary capture denial"];
  const plan = rewriteHistorical(f, { status: "degraded", errors, claims_written: 10, canon_writes: 10 });
  const attested = { ...plan, historical_evidence: { ...plan.historical_evidence,
    allowed_errors_sha256: sha256Hex(canonicalJson(errors)), capture_denial_proof_sha256: sha256Hex("synthetic purge receipt") } };
  expect(() => apply(f, plan)).toThrow("historical_evidence_invalid");
  expect(() => apply(f, { ...attested, historical_evidence: { ...attested.historical_evidence, allowed_errors_sha256: "f".repeat(64) } })).toThrow("historical_evidence_invalid");
  expect(apply(f, attested).status).toBe("accepted");
});

for (const [label, patch] of Object.entries({
  failed: { status: "failed" }, stopped: { stopped: "extract:rejected" }, rejected: { claims_rejected: { schema_invalid: 1 } },
  deduped: { claims_deduped: 1 }, superseded: { claims_superseded: 1 }, skipped: { records_skipped: 1 }, reverted: { canon_reverts: 1 },
  finished: { has_more: false }, nonempty: { claims_extracted: 1 },
  unknown: { model: { calls: 1, answered: 1, unavailable: 0, last_request: "answered", input_tokens: 1, output_tokens: 2, usage_unknown: true } },
  malformed_usage: { model: { calls: 1, answered: 1, unavailable: 0, last_request: "answered", input_tokens: "1", output_tokens: 2 } },
  success_error: { errors: ["synthetic unexpected error"] },
  unbound_degradation: { status: "degraded", errors: ["synthetic error one", "synthetic error two"] },
})) test(`historical extraction refuses ${label} even with an exact rehashed report`, () => {
  const f = fixture(), before = progress(f), plan = rewriteHistorical(f, patch);
  expect(() => apply(f, plan)).toThrow("historical_evidence_invalid");
  expect(progress(f)).toEqual(before);
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
});

test("historical receipt row metadata must agree with the exact retained report", () => {
  const f = fixture();
  f.db.query("UPDATE run_receipts SET status='degraded'").run();
  expect(() => apply(f)).toThrow("historical_evidence_invalid");
});

test("one event cannot acquire another replay operation even with changed producer, old run or bounds", () => {
  const f = fixture(); apply(f);
  const after = progress(f);
  for (const patch of [{}, { new_producer_fingerprint: "f".repeat(64) }, { old_run_id: "another-old-run" },
    { segment: { ...f.plan.segment, done_utf16: f.plan.segment.done_utf16 + 1 } }]) {
    expect(() => apply(f, { ...f.plan, ...patch, operation_id: "second-operation" })).toThrow("replay_conflict");
    expect(progress(f)).toEqual(after);
  }
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toHaveLength(1);
});

test("empty replay settlement requires its run ID and exact operation, bounds and producer linkage", async () => {
  const f = fixture(); apply(f);
  const mined = await mineLiveDrafts(f.db, f.producer, { ...DEFAULT_EXTRACTION_CONFIG, max_input_tokens: 100000 });
  const before = progress(f), settlement = mined.empty_segment_settlement!;
  expect(() => commitExtractCursor(f.db, mined, undefined, f.producer)).toThrow("segment_changed");
  const { empty_segment_settlement: _omitted, ...missingSettlement } = mined;
  expect(() => commitExtractCursor(f.db, missingSettlement, "synthetic-settling-run", f.producer)).toThrow("segment_changed");
  for (const patch of [{ end: settlement.end - 1 }, { replay_operation_id: "wrong-op" }, { content_hash: "f".repeat(64) },
    { producer_fingerprint: "f".repeat(64) }, { model_binding_digest: "f".repeat(64) }]) {
    expect(() => commitExtractCursor(f.db, { ...mined, empty_segment_settlement: { ...settlement, ...patch } }, "synthetic-settling-run", f.producer)).toThrow("segment_changed");
  }
  expect(progress(f)).toEqual(before);
  expect(f.db.query("SELECT * FROM extract_segment_settlements").all()).toEqual([]);
  expect(commitExtractCursor(f.db, mined, "synthetic-settling-run", f.producer)).toBe(true);
  expect(f.db.query("SELECT outcome,replay_operation_id FROM extract_segment_settlements").all())
    .toEqual([{ outcome: "empty", replay_operation_id: f.plan.operation_id }]);
});

for (const [label, mutation] of Object.entries({
  semantic: "UPDATE claim_v2_semantics SET payload='{}'",
  admission: "UPDATE claim_v2_support SET admission='{}'",
  anchors: "UPDATE claim_v2_support SET anchors='[]'",
  key: "UPDATE claim_v2_support SET grant_revision=grant_revision+1",
  content: "UPDATE claim_v2_support_events SET event_content_hash='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
})) test(`typed ${label} corruption cannot prove earlier replay claims disjoint`, async () => {
  const f = fixture("nonempty"); apply(f);
  writeServeToml(f.vault, '[extraction]\nmax_calls_per_pass=1\nmax_input_tokens=5000\n');
  await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
  expect(f.calls).toHaveLength(1);
  expect(progress(f)[0]!.done_utf16).toBeGreaterThan(0);
  expect(activeExtractReplay(f.db, f.event.event_id, f.producer)).not.toBeNull();
  const before = progress(f);
  f.db.exec(mutation);
  expect(() => activeExtractReplay(f.db, f.event.event_id, f.producer)).toThrow("claims_present");
  expect(progress(f)).toEqual(before);
});
