import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { backfillSourceWindow, parseSourceBackfillPlan, sourceBackfillSnapshot } from "../../src/serve/source-backfill";
import { canonicalJson, sha256Hex } from "../../src/util/hash";
import { ENDPOINT, MODEL } from "./throughput-fixture";
import { budgetDay, readDailyBudget } from "../../src/serve/budget-ledger";
import { runRail } from "../../src/serve/rails";
import { inspectCanonRecovery } from "../../src/canon/write-intent";

// Own synthetic Git ancestor; never rely on or modify a shared /tmp/.git.
const parent = mkdtempSync("/home/ubuntu/kizuki-backfill-tests-");
chmodSync(parent, 0o700);
execFileSync("git", ["init", "--quiet", parent]);
const priorTmp = process.env.TMPDIR;
process.env.TMPDIR = parent;
afterAll(() => { if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp; rmSync(parent, { recursive: true, force: true }); });
const fixtures: { db: Database; dispose(): void }[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); f.dispose(); } });
import { sourceBackfillFixture, AT, SOURCE } from "./source-backfill-fixture";
async function fixture(start = 0, supplied = false) { const f = await sourceBackfillFixture(start, supplied); fixtures.push(f); return f; }

const apply = (f: Awaited<ReturnType<typeof fixture>>, plan: unknown = f.plan) => backfillSourceWindow({ db: f.db, vault_path: f.vault, producer: f.producer }, plan);
const tables = ["claims", "claim_v2_semantics", "claim_v2_support", "claim_v2_support_events", "world_observations", "world_observation_events", "rail_cursors", "extract_oversized_records", "extract_segment_settlements", "extract_replay_receipts", "run_receipts", "connections", "checkpoints"];
function stable(f: Awaited<ReturnType<typeof fixture>>) { return Object.fromEntries(tables.map(t => [t, f.db.query<Record<string, unknown>, []>(`SELECT * FROM ${t} ORDER BY rowid`).all()])); }

test("additive backfill inserts only new meaning, preserves every old row and progress, and uses normal canon receipts", async () => {
  const f = await fixture(32), before = stable(f);
  const accepted = await apply(f);
  expect(accepted).toMatchObject({ outcome: "settled", claims_added: [expect.any(String)], supports_added: 1, carried_forward: 2, usage: { calls: 1, input_tokens: 200, output_tokens: 100 } });
  const after = stable(f);
  for (const table of tables) expect(after[table]!.slice(0, before[table]!.length)).toEqual(before[table]!);
  expect(f.calls).toEqual([f.event.text.slice(32, 288)]);
  expect(await apply(f)).toEqual(accepted); expect(f.calls).toHaveLength(1);
  await expect(apply(f, { ...f.plan, operation_id: "bypass" })).rejects.toThrow("backfill_conflict");
  const canon = await runRail(f.db, f.vault, "sync", { syncMode: "canon-only", hooks: { producer: f.producer, claims: { db: f.db, vault_path: f.vault }, model_ref: MODEL } });
  expect(canon.status).toBe("ok"); expect(canon.model.calls).toBe(0); expect(f.calls).toHaveLength(1);
  expect(inspectCanonRecovery(f.db)).toMatchObject({ pending: false, projection_pending: 0 });
  expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM extract_usage").all()).toEqual([]);
  const projected = stable(f);
  expect(projected.extract_oversized_records).toEqual(before.extract_oversized_records);
  for (const table of tables.filter(t => t !== "run_receipts")) expect(projected[table]!.slice(0, before[table]!.length)).toEqual(before[table]!);
  const { exportVault, restoreVault } = await import("../../src/export");
  const { openLedger } = await import("../../src/ledger/db");
  const { join } = await import("node:path");
  const backup = join(f.root, "backup"), restored = join(f.root, "restored");
  exportVault(f.db, f.vault, backup); restoreVault(backup, restored);
  const copy = openLedger(join(restored, ".kizuki/kizuki.db"));
  try {
    for (const table of ["source_backfill_attempts", "source_backfill_results"]) expect(copy.query(`SELECT * FROM ${table}`).all()).toEqual(f.db.query(`SELECT * FROM ${table}`).all());
    expect(copy.query("SELECT done_utf16 FROM extract_oversized_records").get()).toEqual({ done_utf16: f.plan.window.cap_utf16 });
  } finally { copy.close(); }
});

test("changed source policy in flight returns honest terminal rejection without partial claims", async () => {
  const f = await fixture(), before = stable(f);
  f.onCall(() => { revokeSourceGrant(f.db, { source_key: SOURCE, expected_revision: 1, operation_id: "synthetic-revoke" }); });
  const result = await apply(f);
  expect(result).toMatchObject({ outcome: "rejected", reason: "source_changed", claims_added: [], usage: { calls: 1, input_tokens: 200, output_tokens: 100 } });
  expect(stable(f).claims).toEqual(before.claims);
  expect(f.db.query("SELECT * FROM source_backfill_results").all()).toHaveLength(1);
  await expect(apply(f, { ...f.plan, operation_id: "retry" })).rejects.toThrow("backfill_conflict");
  expect(f.calls).toHaveLength(1);
});

test("admission failure rolls back new claims and writes only the terminal refusal", async () => {
  const f = await fixture(), before = stable(f);
  f.db.exec("CREATE TRIGGER fixture_block_new BEFORE INSERT ON world_observations BEGIN SELECT RAISE(ABORT,'synthetic admission failure'); END");
  expect(await apply(f)).toMatchObject({ outcome: "rejected", reason: "admission_refused", claims_added: [] });
  expect(stable(f)).toEqual(before);
  expect(f.db.query("SELECT * FROM leases").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM source_backfill_results").all()).toHaveLength(1);
});

test("measured token overflow and malformed response refuse whole answer and retain actual usage", async () => {
  for (const usage of [{ input_tokens: 8001, output_tokens: 90 }, { input_tokens: 90, output_tokens: 8193 }]) {
    const f = await fixture(), before = stable(f); f.usage(usage);
    expect(await apply(f)).toMatchObject({ outcome: "rejected", claims_added: [], usage: { calls: 1, ...usage }, usage_known: true });
    expect(stable(f)).toEqual(before); expect(f.calls).toHaveLength(1);
  }
  const f = await fixture(), before = stable(f); f.malformed();
  expect(await apply(f)).toMatchObject({ outcome: "rejected", claims_added: [], usage_known: true });
  expect(stable(f)).toEqual(before);
});

test("preflight identity, inventory, cap and budget differences make no attempt or model call", async () => {
  const f = await fixture();
  for (const patch of [{ inventory_sha256: "a".repeat(64) }, { producer_fingerprint: "a".repeat(64) }, { source_revision: 2 },
    { window: { ...f.plan.window, cap_utf16: 513 } }, { budget: { ...f.plan.budget, max_input_tokens: 2000 } }]) {
    await expect(apply(f, { ...f.plan, ...patch })).rejects.toThrow();
  }
  expect(f.calls).toEqual([]); expect(f.db.query("SELECT * FROM source_backfill_attempts").all()).toEqual([]);
  expect(() => parseSourceBackfillPlan({ ...f.plan, window: { ...f.plan.window, end_utf16: 24001, cap_utf16: 24001 } })).toThrow("invalid_plan");
});

test("reserved interrupted attempt cannot resume and conservatively occupies its output reservation", async () => {
  const f = await fixture(), encoded = canonicalJson(f.plan), day = budgetDay(new Date().toISOString());
  f.db.query("INSERT INTO source_backfill_attempts VALUES(?,?,?,?,?,?,?,?,?,?)").run(f.plan.operation_id, f.plan.event_id, f.plan.producer_fingerprint, f.plan.model_binding_digest, 0, 256, 512, sha256Hex(encoded), encoded, new Date().toISOString());
  await expect(apply(f)).rejects.toThrow("backfill_conflict");
  expect(f.calls).toEqual([]); expect(readDailyBudget(f.db, day, "model_output_tokens_per_day")).toBe(8192);
});


test("fresh inventory CAS detects a concurrent claim change before any new insertion", async () => {
  const f = await fixture();
  f.onCall(() => { f.db.query("UPDATE claims SET confidence=0.2 WHERE claim_id=(SELECT claim_id FROM claims LIMIT 1)").run(); });
  const result = await apply(f);
  expect(result).toMatchObject({ outcome: "rejected", reason: "inventory_changed", claims_added: [], usage_known: true });
  expect(f.db.query("SELECT * FROM claims").all()).toHaveLength(3);
  expect(f.db.query("SELECT * FROM source_backfill_results").all()).toHaveLength(1);
});

test("new qualified model binding chains a terminal predecessor, without allowing an identity retry", async () => {
  const f = await fixture();
  // Synthetic historical identity: same implementation, different model binding.
  const previous = { ...f.plan, operation_id: "synthetic-previous", model_binding_digest: sha256Hex("historical synthetic model binding") };
  const bytes = canonicalJson(previous), hash = sha256Hex(bytes);
  const report = canonicalJson({ schema: "kizuki.source-prefix-backfill-result/v1", operation_id: previous.operation_id, plan_sha256: hash,
    outcome: "rejected", usage: { calls: 1, input_tokens: 50, output_tokens: 20 }, usage_known: true, claims_added: [], supports_added: 0,
    carried_forward: 0, response_sha256: null, reason: "admission_refused" });
  f.db.query("INSERT INTO source_backfill_attempts VALUES(?,?,?,?,?,?,?,?,?,?)").run(previous.operation_id, previous.event_id, previous.producer_fingerprint,
    previous.model_binding_digest, 0, 256, 512, hash, bytes, AT);
  f.db.query("INSERT INTO source_backfill_results VALUES(?,?,?,?)").run(previous.operation_id, "rejected", report, AT);
  await expect(apply(f)).rejects.toThrow("backfill_conflict");
  const plan = { ...f.plan, predecessor: { operation_id: previous.operation_id, receipt_sha256: sha256Hex(report) } };
  expect(await apply(f, plan)).toMatchObject({ outcome: "settled", supports_added: 1 });
  expect(f.calls).toHaveLength(1);
});


test("second-record semantic collision refuses without changing any pre-existing claims, supports or observations", async () => {
  const f = await fixture(0, true);
  const { accept } = await import("../../src/ledger/ledger");
  const { validEvent } = await import("../fixtures");
  const { groundedWorldInput } = await import("../../src/serve/world-grounding");
  const { journalWorldDrafts } = await import("../../src/serve/extract");
  const { prepareClaimInsert } = await import("../../src/claims/store");
  const { invokeProducerV2 } = await import("../../src/producer/result");
  // A genuinely shared namespaced supplied identity has a second independent
  // event/support, which the target event's reviewed inventory does not cover.
  const accepted = accept(f.db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: "synthetic-independent-record", text: f.event.text, subjects: f.event.subjects },
    { source: { source_key: SOURCE, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("synthetic source capture failed");
  const event = accepted.event;
  const input = groundedWorldInput(f.db, [{ ...event, text: event.text.slice(0, 256) }], f.plan.budget).input;
  const produced = await invokeProducerV2(f.producer, input);
  if (produced.result.status !== "ok") throw new Error("synthetic collision setup refused");
  const mapped = journalWorldDrafts(f.db, { previous_cursor: null, cursor: null, drafts: [], mined: { status: "ok", count: 3 },
    segment: { event_id: event.event_id, start: 0, end: 256, chars: event.text.length }, world: { input, response: produced.result.response } }, [event], MODEL, f.producer);
  const complete = mapped.drafts.find(d => d.semantic.predicate === "situation.objective")!;
  const prepared = await prepareClaimInsert({ db: f.db, vault_path: f.vault }, complete);
  f.db.transaction(() => prepared.apply()).immediate();
  const before = stable(f);
  const plan = { ...f.plan, ...sourceBackfillSnapshot(f.db, f.event.event_id) };
  expect(await apply(f, plan)).toMatchObject({ outcome: "rejected", reason: "admission_refused", claims_added: [], usage_known: true });
  expect(stable(f)).toEqual(before);
  expect(f.calls).toHaveLength(2); // One explicit setup completion, one backfill attempt.
});

test("terminal receipt failure rolls back every admission and leaves an unresolved no-retry reservation", async () => {
  const f = await fixture(), before = stable(f);
  f.db.exec("CREATE TRIGGER fixture_block_terminal BEFORE INSERT ON source_backfill_results BEGIN SELECT RAISE(ABORT,'synthetic terminal failure'); END");
  expect(await apply(f)).toMatchObject({ outcome: "failed", reason: "terminal_unavailable", claims_added: [], usage_known: true,
    usage: { calls: 1, input_tokens: 200, output_tokens: 100 } });
  expect(stable(f)).toEqual(before);
  expect(f.db.query("SELECT * FROM source_backfill_attempts").all()).toHaveLength(1);
  expect(f.db.query("SELECT * FROM source_backfill_results").all()).toEqual([]);
  expect(readDailyBudget(f.db, budgetDay(new Date().toISOString()), "model_output_tokens_per_day")).toBe(8192);
  await expect(apply(f)).rejects.toThrow("backfill_conflict");
  expect(f.calls).toHaveLength(1);
});


test("an ignored reservation cannot call the model and an ignored result cannot commit claims", async () => {
  const unreserved = await fixture(), before = stable(unreserved);
  unreserved.db.exec("CREATE TRIGGER fixture_ignore_attempt BEFORE INSERT ON source_backfill_attempts BEGIN SELECT RAISE(IGNORE); END");
  await expect(apply(unreserved)).rejects.toThrow("backfill_conflict");
  expect(unreserved.calls).toEqual([]); expect(stable(unreserved)).toEqual(before);
  const missingResult = await fixture(), original = stable(missingResult);
  missingResult.db.exec("CREATE TRIGGER fixture_ignore_result BEFORE INSERT ON source_backfill_results BEGIN SELECT RAISE(IGNORE); END");
  expect(await apply(missingResult)).toMatchObject({ outcome: "failed", reason: "terminal_unavailable", claims_added: [], usage_known: true });
  expect(stable(missingResult)).toEqual(original);
  expect(missingResult.db.query("SELECT * FROM source_backfill_results").all()).toEqual([]);
});

function retiredConnectorEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const prior = f.db.query<Record<string, string | number | null>, []>("SELECT * FROM claims ORDER BY rowid LIMIT 1").get()!;
  const row = { ...prior, claim_id: "synthetic-retired-connector", producer: "deterministic", authority: "connector_evidence",
    is_world_typed: 0, status: "superseded", retracted_at: AT, superseded_by: String(prior.claim_id),
    body: "Synthetic retired connector capture.", body_hash: sha256Hex("Synthetic retired connector capture."),
    subject: null, predicate: null, object: null, claim_key: null, model_ref: null, frontmatter: "{}" };
  const columns = Object.keys(row);
  f.db.query(`INSERT INTO claims (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
  return row.claim_id;
}

test("fully retired non-world connector evidence remains byte-identical alongside live V2 backfill", async () => {
  const f = await fixture(); retiredConnectorEvidence(f);
  const before = stable(f), plan = { ...f.plan, ...sourceBackfillSnapshot(f.db, f.event.event_id) };
  expect(plan.inventory_sha256).not.toBe(f.plan.inventory_sha256);
  expect(await apply(f, plan)).toMatchObject({ outcome: "settled", claims_added: [expect.any(String)], supports_added: 1, carried_forward: 2 });
  const after = stable(f);
  for (const table of tables) expect(after[table]!.slice(0, before[table]!.length)).toEqual(before[table]!);
  expect(f.calls).toHaveLength(1);
});

test("live, unfinished, world-typed or mixed-authority connector history refuses before model or reservation", async () => {
  for (const patch of [{ status: "live" }, { retracted_at: null }, { superseded_by: null }, { receipt_id: null },
    { is_world_typed: 1 }, { producer: "model" }, { authority: "model_inference" }]) {
    const f = await fixture(), id = retiredConnectorEvidence(f);
    for (const [key, value] of Object.entries(patch)) f.db.query(`UPDATE claims SET ${key}=? WHERE claim_id=?`).run(value, id);
    const before = stable(f), plan = { ...f.plan, ...sourceBackfillSnapshot(f.db, f.event.event_id) };
    await expect(apply(f, plan)).rejects.toThrow("inventory_changed");
    expect(stable(f)).toEqual(before); expect(f.calls).toEqual([]);
    expect(f.db.query("SELECT * FROM source_backfill_attempts").all()).toEqual([]);
  }
});


test("retired connector evidence carrying V2 semantics or support is ineligible history", async () => {
  for (const table of ["claim_v2_semantics", "claim_v2_support"]) {
    const f = await fixture(), id = retiredConnectorEvidence(f);
    const prior = f.db.query<Record<string, string | number | null>, []>(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1`).get()!;
    const row: Record<string, string | number | null> = { ...prior, claim_id: id };
    row[table === "claim_v2_semantics" ? "semantic_key" : "support_key"] = sha256Hex("synthetic retired " + table);
    const columns = Object.keys(row);
    f.db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
    const before = stable(f), plan = { ...f.plan, ...sourceBackfillSnapshot(f.db, f.event.event_id) };
    await expect(apply(f, plan)).rejects.toThrow("inventory_changed");
    expect(stable(f)).toEqual(before); expect(f.calls).toEqual([]);
    expect(f.db.query("SELECT * FROM source_backfill_attempts").all()).toEqual([]);
  }
});
