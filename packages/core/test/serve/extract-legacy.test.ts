import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createBudgetTracker } from "../../src/canon/budget";
import { getClaim, insertClaim } from "../../src/claims/store";
import type { ClaimDraft, ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { exportVault, restoreVault } from "../../src/export";
import { commitExtractCursor, completeDurableExtractBatch, fileAndCompleteDurableExtractBatch,
  journalExtractBatch, LegacyExtractReconciliationError, mineLiveDrafts, producedClaimInput,
  readDurableExtractBatch, validateDurableExtractStorage } from "../../src/serve/extract";
import { runRail } from "../../src/serve/rails";
import { listRunReceipts } from "../../src/serve/receipts";
import { runWritePass } from "../../src/serve/write-pass";
import { initVault } from "../../src/vault/init";
import { claimInput, FixtureVectorPort, putEvent } from "../claims/helpers";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-legacy-extract-"));
  const vault = join(root, "vault");
  initVault(vault);
  const ledger = join(vault, ".kizuki", "kizuki.db");
  let db = openLedger(ledger);
  const calls = { count: 0 };
  const event = putEvent(db);
  const draft = (subject: string): ClaimDraft => ({ kind: "claim", subject,
    predicate: "employment.works_at", object: "Acme", polarity: "positive",
    body: `${subject} works at Acme.`, valid_from: null, valid_to: null,
    confidence: 0.8, sensitivity: "personal", event_ids: [event] });
  const model: ProducerPort = {
    descriptor: { id: "kizuki.producer.legacy-replay-test", kind: "producer", contract: "kizuki.producer/v1",
      contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready", detail: {} }), close: async () => undefined,
    produce: async () => { calls.count++; return { status: "ok",
      claims: [draft("person:first"), draft("person:second")], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }; },
  };
  return { root, vault, ledger, event, model, calls, get db() { return db; },
    reopen: () => { db.close(); db = openLedger(ledger); },
    close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** Exact pre-atomic on-disk digest; do not use the current production encoder. */
function makePreAtomic(db: Database): void {
  const row = db.query<{ previous_cursor: string; cursor: string; model_ref: string | null;
    input_ids: string; batch_mode: string; model_inputs: string; deferred_inputs: string;
    outcome: string; drafts: string }, []>("SELECT * FROM extract_batches").get()!;
  const digest = createHash("sha256").update(JSON.stringify([
    row.previous_cursor || null, row.cursor, row.model_ref, JSON.parse(row.input_ids), row.batch_mode,
    JSON.parse(row.model_inputs), JSON.parse(row.deferred_inputs), row.outcome,
    (JSON.parse(row.drafts) as ClaimDraft[]).map(d => [d.kind, d.subject, d.predicate, d.object, d.polarity,
      d.body, d.valid_from, d.valid_to, d.confidence, d.sensitivity, d.event_ids]),
  ])).digest("hex");
  db.query("UPDATE extract_batches SET integrity=?").run(digest);
}

function authoritativeRows(db: Database): string {
  return JSON.stringify(["claims", "claim_supersessions", "extract_batches", "extract_deferred_inputs", "checkpoints", "retrieval_ops"]
    .map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}

test("upgrade refuses a committed structural prefix without changing any authoritative row", async () => {
  const f = fixture();
  try {
    const initial = await insertClaim({ db: f.db }, claimInput(f.event, {
      subject: "person:first", body: "The original employment wording.", producer: "model", confidence: 0.2,
    }));
    if (initial.outcome !== "stored") throw new Error("fixture claim was not stored");
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:legacy-partial", f.model);
    const pending = readDurableExtractBatch(f.db, f.model)!;
    await insertClaim({ db: f.db }, producedClaimInput(f.db, pending.filing_drafts[0]!, "model", pending.model_ref));
    makePreAtomic(f.db);
    // Retain unrelated pending work too, so refusal cannot hide a queue reset or refresh.
    const later = putEvent(f.db, { source_record_id: "later-deferred-input" });
    f.db.query("INSERT INTO extract_deferred_inputs(event_id,source_key,checked_revision,checked_binding_digest) VALUES (?,NULL,0,?)")
      .run(later, pending.model_inputs[0]!.checked_binding_digest);
    f.db.query("INSERT INTO retrieval_ops(op_id,store,op,doc_id,state,created_at) VALUES ('fixture-old-op',?,'upsert',?,'pending','2026-09-05T12:00:00Z')")
      .run(new FixtureVectorPort().descriptor.id, initial.claim.claim_id);
    const retrieval = new FixtureVectorPort();
    expect(getClaim(f.db, initial.claim.claim_id)?.corroboration).toBe(2);
    const before = authoritativeRows(f.db);
    f.reopen();
    await expect(runWritePass(f.db, f.vault, { producer: f.model, model_ref: "fixture:current", claims: { db: f.db, retrieval },
      budget: createBudgetTracker({ canon_writes_per_run: 8 }) })).rejects.toThrow("Legacy extraction needs reconciliation");
    expect(authoritativeRows(f.db)).toBe(before);
    expect(getClaim(f.db, initial.claim.claim_id)?.corroboration).toBe(2);
    expect(f.calls.count).toBe(1);
    expect(retrieval.docs.size).toBe(0);
  } finally { f.close(); }
});

for (const nullManifest of [false, true]) test(`every extraction effect seam refuses legacy rows, null manifest=${nullManifest}`, async () => {
  const f = fixture();
  try {
    const mined = await mineLiveDrafts(f.db, f.model);
    journalExtractBatch(f.db, mined, "fixture:legacy", f.model);
    const formerlyAtomic = readDurableExtractBatch(f.db, f.model)!;
    if (nullManifest) f.db.exec("UPDATE extract_batches SET integrity=NULL,input_ids=NULL,model_inputs=NULL,deferred_inputs=NULL");
    else makePreAtomic(f.db);
    const before = authoritativeRows(f.db);
    // Looking wholly unfiled is not proof; even storage validation must not upgrade it.
    validateDurableExtractStorage(f.db);
    expect(authoritativeRows(f.db)).toBe(before);
    expect(() => readDurableExtractBatch(f.db, f.model)).toThrow(LegacyExtractReconciliationError);
    expect(() => completeDurableExtractBatch(f.db, formerlyAtomic, f.model)).toThrow(LegacyExtractReconciliationError);
    expect(() => fileAndCompleteDurableExtractBatch(f.db, formerlyAtomic, f.model, [])).toThrow(LegacyExtractReconciliationError);
    expect(() => journalExtractBatch(f.db, mined, "fixture:new", f.model)).toThrow(LegacyExtractReconciliationError);
    expect(() => commitExtractCursor(f.db, { ...mined, mined: { status: "empty" }, drafts: [] })).toThrow(LegacyExtractReconciliationError);
    await expect(mineLiveDrafts(f.db, f.model)).rejects.toThrow(LegacyExtractReconciliationError);
    expect(authoritativeRows(f.db)).toBe(before);
    expect(f.calls.count).toBe(1);
  } finally { f.close(); }
});

test("the sync rail records a fixed safe legacy refusal and preserves the saved decision", async () => {
  const f = fixture();
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:private-legacy-model", f.model);
    makePreAtomic(f.db);
    const before = authoritativeRows(f.db);
    const receipt = await runRail(f.db, f.vault, "sync", {
      hooks: { producer: f.model, claims: { db: f.db }, model_ref: "fixture:current" },
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.stopped).toBe("legacy_extraction_reconciliation_required");
    expect(receipt.errors).toEqual([new LegacyExtractReconciliationError().message]);
    expect(listRunReceipts(f.db)[0]!.errors).toEqual(receipt.errors);
    expect(listRunReceipts(f.db)[0]!.stopped).toBe(receipt.stopped);
    expect(authoritativeRows(f.db)).toBe(before);
    expect(f.calls.count).toBe(1);
  } finally { f.close(); }
});

test("a current atomic envelope survives backup, restore and reopen exactly before one filing", async () => {
  const f = fixture();
  let restored: Database | undefined;
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:atomic-backup", f.model);
    const before = f.db.query("SELECT * FROM extract_batches").all();
    expect(before[0]).toMatchObject({ integrity: expect.stringMatching(/^atomic-v1:[a-f0-9]{64}$/) });
    const backup = join(f.root, "backup");
    const target = join(f.root, "restored");
    exportVault(f.db, f.vault, backup);
    restoreVault(backup, target);
    const ledger = join(target, ".kizuki", "kizuki.db");
    restored = openLedger(ledger);
    expect(restored.query("SELECT * FROM extract_batches").all()).toEqual(before);
    restored.close();
    restored = openLedger(ledger);
    await runWritePass(restored, target, { producer: f.model, model_ref: "fixture:current", claims: { db: restored },
      budget: createBudgetTracker({ canon_writes_per_run: 0 }) });
    expect(restored.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(restored.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 2 });
    expect(f.calls.count).toBe(1);
  } finally { restored?.close(); f.close(); }
});

test("a bare-digest legacy backup preserves its committed structural effect and replay refusal", async () => {
  const f = fixture();
  let restored: Database | undefined;
  try {
    const initial = await insertClaim({ db: f.db }, claimInput(f.event, {
      subject: "person:first", body: "The original employment wording.", producer: "model", confidence: 0.2,
    }));
    if (initial.outcome !== "stored") throw new Error("fixture claim was not stored");
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:legacy-backup", f.model);
    const pending = readDurableExtractBatch(f.db, f.model)!;
    await insertClaim({ db: f.db }, producedClaimInput(f.db, pending.filing_drafts[0]!, "model", pending.model_ref));
    makePreAtomic(f.db);
    const journal = f.db.query("SELECT * FROM extract_batches").all();
    const claim = getClaim(f.db, initial.claim.claim_id);
    const backup = join(f.root, "legacy-backup");
    const target = join(f.root, "legacy-restored");
    exportVault(f.db, f.vault, backup);
    restoreVault(backup, target);
    restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    expect(restored.query("SELECT * FROM extract_batches").all()).toEqual(journal);
    expect(getClaim(restored, initial.claim.claim_id)).toEqual(claim);
    const before = authoritativeRows(restored);
    await expect(runWritePass(restored, target, { producer: f.model, model_ref: "fixture:current", claims: { db: restored },
      budget: createBudgetTracker({ canon_writes_per_run: 8 }) })).rejects.toThrow(LegacyExtractReconciliationError);
    expect(authoritativeRows(restored)).toBe(before);
    expect(getClaim(restored, initial.claim.claim_id)?.corroboration).toBe(2);
    expect(f.calls.count).toBe(1);
  } finally { restored?.close(); f.close(); }
});

for (const envelope of ["atomic-v2:" + "a".repeat(64), "atomic-v1:", "atomic-v1:" + "A".repeat(64),
  "atomic-v1:" + "a".repeat(65), "atomic-v1:" + "a".repeat(64), "untrusted-private-fixture"]) {
  test(`unsupported or corrupt envelope stays unchanged: ${envelope.slice(0, 14)}/${envelope.length}`, async () => {
    const f = fixture();
    try {
      journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:atomic", f.model);
      f.db.query("UPDATE extract_batches SET integrity=?").run(envelope);
      const before = authoritativeRows(f.db);
      expect(() => readDurableExtractBatch(f.db, f.model)).toThrow();
      expect(() => validateDurableExtractStorage(f.db)).toThrow();
      expect(() => exportVault(f.db, f.vault, join(f.root, "bad-backup"))).toThrow();
      expect(authoritativeRows(f.db)).toBe(before);
      expect(f.calls.count).toBe(1);
    } finally { f.close(); }
  });
}

test("authorized purge preserves the unhashed legacy format and cannot enable the surviving decision", async () => {
  const f = fixture();
  try {
    const other = putEvent(f.db, { source_record_id: "legacy-unclaimed-second" });
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:legacy-purge", f.model);
    f.db.exec("UPDATE extract_batches SET integrity=NULL,input_ids=NULL,model_inputs=NULL,deferred_inputs=NULL");
    purgeEvents(f.db, f.vault, { event_id: other }, "synthetic legacy input purge");
    expect(f.db.query("SELECT integrity,input_ids,model_inputs,deferred_inputs FROM extract_batches").get())
      .toEqual({ integrity: null, input_ids: null, model_inputs: null, deferred_inputs: null });
    validateDurableExtractStorage(f.db);
    expect(() => readDurableExtractBatch(f.db, f.model)).toThrow(LegacyExtractReconciliationError);
  } finally { f.close(); }
});
