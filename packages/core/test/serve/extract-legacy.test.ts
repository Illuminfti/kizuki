import { statSync } from "node:fs";
import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createBudgetTracker } from "../../src/canon/budget";
import { getClaim, insertClaim } from "../../src/claims/store";
import type { ClaimDraft, ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { exportVault, restoreVault } from "../../src/export";
import { commitExtractCursor, completeDurableExtractBatch, fileAndCompleteDurableExtractBatch,
  journalExtractBatch, LegacyExtractReconciliationError, mineLiveDrafts, producedClaimInput,
  readDurableExtractBatch, requireAtomicExtractReplay, validateDurableExtractStorage } from "../../src/serve/extract";
import { runRail } from "../../src/serve/rails";
import { listRunReceipts, persistRunReceipt, runReceiptsPath } from "../../src/serve/receipts";
import { emptyRunTotals } from "../../src/serve/types";
import { runWritePass } from "../../src/serve/write-pass";
import { initVault } from "../../src/vault/init";
import { claimInput, FixtureVectorPort, putEvent } from "../claims/helpers";
import { commitMachineByteIntent } from "../../src/ledger/event-origin";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";

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

async function runResourceProbe(code: string, timeoutMs = 10_000) {
  const child = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("resource probe deadline exceeded")); }, timeoutMs);
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.race([output, deadline]);
    const usage = child.resourceUsage();
    if (usage === undefined) throw new Error("resource probe usage is unavailable");
    return { exitCode, stdout, stderr, maxRssKiB: usage.maxRSS };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled([output]);
  }
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

for (const corruption of ["digest", "created_at"] as const) for (const rail of [false, true]) for (const configured of [false, true]) {
  test(`full corrupt-${corruption} preflight precedes all maintenance, rail=${rail}, ports=${configured}`, async () => {
    const f = fixture();
    try {
      journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:preflight", f.model);
      const batch = readDurableExtractBatch(f.db, f.model)!;
      const claim = await insertClaim({ db: f.db }, claimInput(f.event, { subject: "person:unrelated", body: "Unrelated claim." }));
      if (claim.outcome !== "stored") throw new Error("fixture claim was not stored");
      f.db.query("UPDATE claims SET status='skipped' WHERE claim_id=?").run(claim.claim.claim_id);
      const at = "2026-09-05T12:00:00.000Z";
      const canon = join(f.vault, "people", "preflight.md");
      mkdirSync(join(f.vault, "people"), { recursive: true });
      writeFileSync(canon, "# Preserved synthetic canon\n");
      const hash = sha256Hex(readFileSync(canon));
      f.db.query("INSERT INTO canon_receipts(receipt_id,provenance,sensitivity,page_path,after_hash,at) VALUES ('old-canon',?,'personal','people/preflight.md',?,?)")
        .run(JSON.stringify([f.event]), hash, at);
      f.db.query("INSERT INTO canon_write_reservations(receipt_id,day,page_path,before_hash) VALUES ('old-reservation','2026-09-05','people/preflight.md',?)").run(hash);
      const later = putEvent(f.db, { source_record_id: "preflight-deferred" });
      f.db.query("INSERT INTO extract_deferred_inputs(event_id,source_key,checked_revision,checked_binding_digest) VALUES (?,NULL,0,?)")
        .run(later, batch.model_inputs[0]!.checked_binding_digest);
      const retrieval = new FixtureVectorPort();
      f.db.query("INSERT INTO retrieval_ops(op_id,store,op,doc_id,state,created_at) VALUES ('old-outbox',?,'upsert',?,'pending',?)")
        .run(retrieval.descriptor.id, claim.claim.claim_id, at);
      const oldReceipt = { ...emptyRunTotals(), run_id: "preflight-old-run", rail: "sync" as const,
        started_at: at, finished_at: at, status: "ok" as const, stopped: null, errors: [] };
      persistRunReceipt(f.db, f.vault, oldReceipt);
      // A pending JSONL import and orphan usage make premature rail recovery observable.
      expect(() => persistRunReceipt(f.db, f.vault, { ...oldReceipt, run_id: "preflight-unimported-run" }, { crashAfter: "after-jsonl" })).toThrow();
      f.db.query("INSERT INTO extract_usage(run_id,model_ref,metrics,holder_pid,created_at) VALUES ('preflight-orphan','fixture:old',?,?,?)")
        .run(JSON.stringify({ ...emptyRunTotals(), claims_rejected: {}, claims_extracted: 0 }), process.pid, at);
      commitMachineByteIntent(f.db, { receipt_id: ulid(), before_hash: null,
        after_hash: sha256Hex("Grace runs partnerships at Acme.") }, () => {});
      if (corruption === "digest") f.db.query("UPDATE extract_batches SET integrity=?").run(`atomic-v1:${"a".repeat(64)}`);
      else f.db.query("UPDATE extract_batches SET created_at='not-a-timestamp'").run();
      const expectedError = corruption === "digest" ? "durable extraction integrity mismatch" : "durable extraction batch is corrupt";
      const rows = () => JSON.stringify([authoritativeRows(f.db), ...["canon_write_reservations", "budget_ledger", "canon_receipts", "events", "extract_usage",
        "source_grants", "source_event_bindings", "source_grant_receipts", "canon_machine_byte_intents"]
        .map(table => f.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all())]);
      const before = rows();
      const receipts = f.db.query("SELECT * FROM run_receipts ORDER BY rowid").all();
      const receiptBytes = readFileSync(runReceiptsPath(f.vault), "utf8");
      const canonBytes = readFileSync(canon);
      const flockBefore = existsSync(join(f.vault, ".kizuki", "write-pass.flock"));
      const schedules = f.db.query<{ rail: string }, []>("SELECT * FROM schedules ORDER BY rail").all();
      let portCalls = 0;
      let syncCalls = 0;
      retrieval.search = async () => { portCalls++; throw new Error("unexpected retrieval call"); };
      retrieval.upsert = async () => { portCalls++; throw new Error("unexpected retrieval call"); };
      retrieval.remove = async () => { portCalls++; throw new Error("unexpected retrieval call"); };
      const hooks = configured ? { producer: f.model, claims: { db: f.db, retrieval }, model_ref: "fixture:current" } : {};
      if (rail) {
        const failed = await runRail(f.db, f.vault, "sync", { hooks: { ...hooks,
          sync: async () => { syncCalls++; throw new Error("unexpected connector call"); } }, now: () => at });
        expect(failed.status).toBe("failed");
        expect(failed.errors).toEqual([expectedError]);
        expect(f.db.query("SELECT * FROM run_receipts WHERE run_id<>? ORDER BY rowid").all(failed.run_id)).toEqual(receipts);
        const afterBytes = readFileSync(runReceiptsPath(f.vault), "utf8");
        expect(afterBytes.startsWith(receiptBytes)).toBe(true);
        expect(afterBytes.slice(receiptBytes.length).trim().split("\n")).toHaveLength(1);
        // Only this new failure receipt's normal schedule transition is permitted.
        expect(f.db.query("SELECT * FROM schedules WHERE rail<>'sync' ORDER BY rail").all())
          .toEqual(schedules.filter(row => row.rail !== "sync"));
      } else {
        await expect(runWritePass(f.db, f.vault, { ...hooks, budget: createBudgetTracker({ canon_writes_per_run: 8 }) }))
          .rejects.toThrow(expectedError);
        expect(f.db.query("SELECT * FROM run_receipts ORDER BY rowid").all()).toEqual(receipts);
        expect(readFileSync(runReceiptsPath(f.vault), "utf8")).toBe(receiptBytes);
        expect(f.db.query("SELECT * FROM schedules ORDER BY rail").all()).toEqual(schedules);
      }
      expect(rows()).toBe(before);
      expect(readFileSync(canon)).toEqual(canonBytes);
      expect(f.calls.count).toBe(1);
      expect(portCalls).toBe(0);
      expect(syncCalls).toBe(0);
      expect(existsSync(join(f.vault, ".kizuki", "write-pass.flock"))).toBe(flockBefore);
    } finally { f.close(); }
  });
}

test("full valid-row preflight is pure even when a later intent would refresh origin", async () => {
  const f = fixture();
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:pure-preflight", f.model);
    commitMachineByteIntent(f.db, { receipt_id: ulid(), before_hash: null,
      after_hash: sha256Hex("Grace runs partnerships at Acme.") }, () => {});
    const before = f.db.query("SELECT * FROM events ORDER BY rowid").all();
    requireAtomicExtractReplay(f.db);
    expect(f.db.query("SELECT * FROM events ORDER BY rowid").all()).toEqual(before);
    expect(f.calls.count).toBe(1);
  } finally { f.close(); }
});

test("stored text is decoded without replacing malformed UTF-8 or removing a valid BOM", async () => {
  const f = fixture();
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:\uFFFD\0é🙂", f.model);
    const row = f.db.query<{ previous_cursor: string; cursor: string; model_ref: string; input_ids: string;
      batch_mode: string; model_inputs: string; deferred_inputs: string; outcome: string; drafts: string }, []>("SELECT * FROM extract_batches").get()!;
    const setModelRef = (value: string) => {
      const digest = createHash("sha256").update("kizuki.extract-filing/atomic-v1\0").update(JSON.stringify([
        row.previous_cursor || null, row.cursor, value, JSON.parse(row.input_ids), row.batch_mode,
        JSON.parse(row.model_inputs), JSON.parse(row.deferred_inputs), row.outcome,
        (JSON.parse(row.drafts) as ClaimDraft[]).map(d => [d.kind, d.subject, d.predicate, d.object, d.polarity,
          d.body, d.valid_from, d.valid_to, d.confidence, d.sensitivity, d.event_ids]),
      ])).digest("hex");
      // Bind raw bytes because Bun's SQLite string binder strips a leading BOM.
      f.db.query("UPDATE extract_batches SET model_ref=CAST(? AS TEXT),integrity=?").run(Buffer.from(value), `atomic-v1:${digest}`);
    };
    setModelRef("\uFEFFfixture:\uFFFD\0é🙂");
    expect(() => requireAtomicExtractReplay(f.db)).not.toThrow();
    setModelRef("");
    const before = f.db.query("SELECT * FROM extract_batches").all();
    // The driver's default string decoding maps this invalid byte to empty text,
    // producing the same decoded row and digest as the original valid text.
    f.db.exec("UPDATE extract_batches SET model_ref=CAST(x'ff' AS TEXT)");
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual(before);
    expect(() => requireAtomicExtractReplay(f.db)).toThrow("durable extraction batch is corrupt");
    expect(f.db.query("SELECT hex(CAST(model_ref AS BLOB)) AS bytes FROM extract_batches").get())
      .toEqual({ bytes: "FF" });
  } finally { f.close(); }
});

test("metadata admission and payload fetch use one SQLite snapshot", async () => {
  const f = fixture();
  const writer = new Database(f.ledger);
  const query = f.db.query.bind(f.db);
  const statementSpies: { mockRestore(): void }[] = [];
  let concurrentWrites = 0;
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:snapshot", f.model);
    const querySpy = spyOn(f.db, "query").mockImplementation(<Row, Params extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) => {
      const statement = query<Row, Params>(sql);
      if (sql.includes("typeof(") && sql.includes("extract_batches")) {
        const all = statement.all.bind(statement);
        statementSpies.push(spyOn(statement, "all").mockImplementation((...params) => {
          const metadata = all(...params);
          writer.exec("UPDATE extract_batches SET model_ref=CAST(zeroblob(4096) AS TEXT)");
          concurrentWrites++;
          return metadata;
        }));
      }
      return statement;
    });
    try {
      expect(() => requireAtomicExtractReplay(f.db)).not.toThrow();
      expect(concurrentWrites).toBe(1);
    } finally {
      for (const spy of statementSpies.reverse()) spy.mockRestore();
      querySpy.mockRestore();
    }
    // A subsequent preflight sees and refuses the newly committed row.
    expect(() => requireAtomicExtractReplay(f.db)).toThrow("durable extraction batch is corrupt");
  } finally { writer.close(); f.close(); }
});

test("a 128 MiB stored text refuses with bounded memory through guard, writer and sync rail", async () => {
  const f = fixture();
  const writerBefore = statSync(join(f.vault, ".kizuki", "write-pass.flock"));
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.model), "fixture:resource-bound", f.model);
    // Construct hostile bytes inside SQLite, avoiding a giant JS fixture string.
    f.db.query("UPDATE extract_batches SET drafts=CAST(zeroblob(?) AS TEXT)").run(128 * 1024 * 1024);
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const entry of ["guard", "writer", "rail"]) {
      const reader = `
        import { Database } from "bun:sqlite";
        import { requireAtomicExtractReplay } from ${JSON.stringify(join(import.meta.dir, "../../src/serve/extract.ts"))};
        import { runWritePass } from ${JSON.stringify(join(import.meta.dir, "../../src/serve/write-pass.ts"))};
        import { runRail } from ${JSON.stringify(join(import.meta.dir, "../../src/serve/rails.ts"))};
        import { createBudgetTracker } from ${JSON.stringify(join(import.meta.dir, "../../src/canon/budget.ts"))};
        const db = new Database(${JSON.stringify(f.ledger)});
        let error = null, hookCalls = 0;
        try {
          if (${JSON.stringify(entry)} === "guard") requireAtomicExtractReplay(db);
          else if (${JSON.stringify(entry)} === "writer") await runWritePass(db, ${JSON.stringify(f.vault)}, { budget: createBudgetTracker({ canon_writes_per_run: 8 }) });
          else {
            const receipt = await runRail(db, ${JSON.stringify(f.vault)}, "sync", { hooks: { sync: async () => { hookCalls++; throw new Error("unexpected hook"); } } });
            if (receipt.status !== "failed") throw new Error("unexpected successful rail");
            error = receipt.errors[0];
          }
        } catch (cause) { error = cause instanceof Error ? cause.message : "unexpected error"; }
        db.close();
        console.log(JSON.stringify({ error, hookCalls }));
      `;
      // A fresh supervisor excludes the test runner's inherited peak (including
      // fixture construction) from the measured reader's subprocess usage.
      const child = await runResourceProbe(`
        const measured = await (${runResourceProbe.toString()})(${JSON.stringify(reader)});
        console.log(JSON.stringify(measured));
      `, 20_000);
      expect(child.exitCode).toBe(0);
      expect(child.stderr).toBe("");
      const measured = JSON.parse(child.stdout) as { exitCode: number; stdout: string; stderr: string; maxRssKiB: number };
      expect(measured.exitCode).toBe(0);
      expect(measured.stderr).toBe("");
      expect(JSON.parse(measured.stdout)).toEqual({ error: "durable extraction batch is corrupt", hookCalls: 0 });
      // Includes Bun and all imported modules, with ample room above their
      // normal footprint. The rejected reader exceeded 580 MiB on this input.
      // Pinned Bun reports subprocess maxRSS in KiB on the Linux test runner.
      expect(measured.maxRssKiB).toBeLessThan(192 * 1024);
    }
    const writerAfter = statSync(join(f.vault, ".kizuki", "write-pass.flock"));
    expect([writerAfter.dev, writerAfter.ino, writerAfter.mtimeMs, writerAfter.ctimeMs])
      .toEqual([writerBefore.dev, writerBefore.ino, writerBefore.mtimeMs, writerBefore.ctimeMs]);
    expect(existsSync(join(f.vault, ".kizuki", "write-pass.lock"))).toBe(false);
    expect(f.calls.count).toBe(1);
  } finally { f.close(); }
}, 45_000);
