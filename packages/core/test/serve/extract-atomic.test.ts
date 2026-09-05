import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { getClaim, insertClaim, pendingRetrievalOps, retryRetrievalOps } from "../../src/claims/store";
import type { ClaimDraft, ProducerPort } from "../../src/contracts/producer";
import type { RetrievalDoc } from "../../src/contracts/retrieval";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { readExtractCursor } from "../../src/serve/extract";
import { runWritePass } from "../../src/serve/write-pass";
import { initVault } from "../../src/vault/init";
import { claimInput, FixtureVectorPort, putEvent } from "../claims/helpers";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-extract-atomic-"));
  const path = join(root, "vault");
  initVault(path);
  const ledger = join(path, ".kizuki", "kizuki.db");
  let db = openLedger(ledger);
  return { path, ledger, get db() { return db; }, reopen: () => { db.close(); db = openLedger(ledger); },
    close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

function draft(event: string, subject: string, overrides: Partial<ClaimDraft> = {}): ClaimDraft {
  return { kind: "claim", subject, predicate: "employment.works_at", object: "Acme", polarity: "positive",
    body: `${subject} works at Acme.`, valid_from: null, valid_to: null, confidence: 0.8,
    sensitivity: "personal", event_ids: [event], ...overrides };
}

function producer(claims: ClaimDraft[], calls: { count: number }): ProducerPort {
  return {
    descriptor: { id: "kizuki.producer.atomic-test", kind: "producer", contract: "kizuki.producer/v1",
      contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready", detail: {} }), close: async () => undefined,
    produce: async () => { calls.count++; return { status: "ok", claims, usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }; },
  };
}

test("a later draft failure rolls back the entire batch, then replay files it once", async () => {
  const f = fixture();
  try {
    const event = putEvent(f.db);
    const calls = { count: 0 };
    const retrieval = new FixtureVectorPort();
    const options = { producer: producer([draft(event, "person:first"), draft(event, "person:second")], calls),
      model_ref: "fixture:atomic", claims: { db: f.db, retrieval }, budget: createBudgetTracker({ canon_writes_per_run: 8 }) };
    f.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON claims WHEN NEW.subject='person:second' BEGIN SELECT RAISE(ABORT,'atomic interruption'); END");
    await expect(runWritePass(f.db, f.path, options)).rejects.toThrow("atomic interruption");
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM retrieval_ops").get()).toEqual({ n: 0 });
    expect(retrieval.docs.size).toBe(0);
    expect(readExtractCursor(f.db)).toBeNull();
    expect(f.db.query("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 1 });
    f.db.exec("DROP TRIGGER fail_second");
    const replay = await runWritePass(f.db, f.path, options);
    expect(replay.errors).toEqual([]);
    expect(calls.count).toBe(1);
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 2 });
    expect(f.db.query("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 0 });
    expect(readExtractCursor(f.db)).toContain(event);
  } finally { f.close(); }
});

test("failed batch rolls back corroboration and recovery does not repeat its increment", async () => {
  const f = fixture();
  try {
    const event = putEvent(f.db);
    const initial = await insertClaim({ db: f.db }, claimInput(event, { subject: "person:first", body: "The first existing claim.",
      producer: "model", confidence: 0.2 }));
    if (initial.outcome !== "stored") throw new Error("fixture claim was not stored");
    const before = getClaim(f.db, initial.claim.claim_id);
    const calls = { count: 0 };
    const options = { producer: producer([draft(event, "person:first"), draft(event, "person:second")], calls),
      model_ref: "fixture:atomic", claims: { db: f.db }, budget: createBudgetTracker({ canon_writes_per_run: 8 }) };
    f.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON claims WHEN NEW.subject='person:second' BEGIN SELECT RAISE(ABORT,'atomic interruption'); END");
    await expect(runWritePass(f.db, f.path, options)).rejects.toThrow("atomic interruption");
    expect(getClaim(f.db, initial.claim.claim_id)).toEqual(before);
    f.db.exec("DROP TRIGGER fail_second");
    await runWritePass(f.db, f.path, options);
    expect(getClaim(f.db, initial.claim.claim_id)?.corroboration).toBe(2);
    expect(calls.count).toBe(1);
    expect(f.db.query("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test("retrieval observes the committed decision and only the final live claims", async () => {
  const f = fixture();
  const observer = openLedger(f.ledger);
  try {
    const event = putEvent(f.db);
    const pendingAtPublication: number[] = [];
    class ObservingPort extends FixtureVectorPort {
      override async upsert(docs: readonly RetrievalDoc[]) {
        pendingAtPublication.push(observer.query<{ n: number }, []>("SELECT count(*) AS n FROM extract_batches").get()!.n);
        expect(observer.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 2 });
        expect(observer.query("SELECT count(*) AS n FROM claims WHERE status='live'").get()).toEqual({ n: 1 });
        return super.upsert(docs);
      }
    }
    const retrieval = new ObservingPort();
    const calls = { count: 0 };
    const result = await runWritePass(f.db, f.path, { producer: producer([
      draft(event, "person:first", { body: "First worked at OldCo.", object: "OldCo", confidence: 0.2, valid_from: "2026-09-01T00:00:00.000Z" }),
      draft(event, "person:first", { body: "First works at NewCo.", object: "NewCo", confidence: 0.5, valid_from: "2026-09-02T00:00:00.000Z" }),
    ], calls), model_ref: "fixture:atomic", claims: { db: f.db, retrieval }, budget: createBudgetTracker({ canon_writes_per_run: 8 }) });
    expect(result.errors).toEqual([]);
    expect(pendingAtPublication.length).toBeGreaterThan(0);
    expect(pendingAtPublication.every(count => count === 0)).toBe(true);
    expect([...retrieval.docs.values()].map(doc => doc.text)).toEqual(["First works at NewCo."]);
    expect(f.db.query("SELECT count(*) AS n FROM claims WHERE status='superseded'").get()).toEqual({ n: 1 });
  } finally { observer.close(); f.close(); }
});

test("a later draft failure restores supersession state and queues no retrieval effect", async () => {
  const f = fixture();
  try {
    const event = putEvent(f.db);
    const initial = await insertClaim({ db: f.db }, claimInput(event, { subject: "person:first", object: "OldCo",
      body: "The previous employment.", producer: "model", confidence: 0.2, valid_from: "2026-09-01T00:00:00.000Z" }));
    if (initial.outcome !== "stored") throw new Error("fixture claim was not stored");
    const before = getClaim(f.db, initial.claim.claim_id);
    const retrieval = new FixtureVectorPort();
    const calls = { count: 0 };
    f.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON claims WHEN NEW.subject='person:second' BEGIN SELECT RAISE(ABORT,'atomic interruption'); END");
    await expect(runWritePass(f.db, f.path, { producer: producer([
      draft(event, "person:first", { object: "NewCo", confidence: 0.5, valid_from: "2026-09-02T00:00:00.000Z" }),
      draft(event, "person:second"),
    ], calls), model_ref: "fixture:atomic", claims: { db: f.db, retrieval }, budget: createBudgetTracker({ canon_writes_per_run: 8 }) }))
      .rejects.toThrow("atomic interruption");
    expect(getClaim(f.db, initial.claim.claim_id)).toEqual(before);
    expect(f.db.query("SELECT count(*) AS n FROM claim_supersessions").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 1 });
    expect(pendingRetrievalOps(f.db)).toEqual([]);
    expect(retrieval.docs.size).toBe(0);
    expect(readExtractCursor(f.db)).toBeNull();
  } finally { f.close(); }
});

test("retrieval failure and restart drain the outbox without replaying corroboration", async () => {
  const f = fixture();
  try {
    const event = putEvent(f.db);
    const initial = await insertClaim({ db: f.db }, claimInput(event, { subject: "person:first", body: "The first existing claim.",
      producer: "model", confidence: 0.2 }));
    if (initial.outcome !== "stored") throw new Error("fixture claim was not stored");
    class FailingPort extends FixtureVectorPort {
      failing = true;
      override async upsert(docs: readonly RetrievalDoc[]) {
        if (this.failing) throw new Error("synthetic retrieval unavailable");
        return super.upsert(docs);
      }
    }
    const retrieval = new FailingPort();
    const calls = { count: 0 };
    const model = producer([draft(event, "person:first")], calls);
    const budget = createBudgetTracker({ canon_writes_per_run: 8 });
    await runWritePass(f.db, f.path, { producer: model, model_ref: "fixture:atomic", claims: { db: f.db, retrieval }, budget });
    expect(getClaim(f.db, initial.claim.claim_id)?.corroboration).toBe(2);
    expect(pendingRetrievalOps(f.db)).toHaveLength(1);
    expect(f.db.query("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 0 });
    f.reopen();
    retrieval.failing = false;
    await runWritePass(f.db, f.path, { producer: model, model_ref: "fixture:atomic", claims: { db: f.db, retrieval }, budget });
    expect(calls.count).toBe(1);
    expect(getClaim(f.db, initial.claim.claim_id)?.corroboration).toBe(2);
    expect(await retryRetrievalOps({ db: f.db, retrieval })).toEqual({ retried: 1, pending: 0 });
    expect(retrieval.docs.has(`claim:${initial.claim.claim_id}`)).toBe(true);
    expect(f.db.query("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test("a producer label cannot use self evidence to corroborate an external claim", async () => {
  const f = fixture();
  try {
    const external = putEvent(f.db);
    const self = putEvent(f.db, { text: "KIZUKI CONTEXT v1\nsynthetic copied output" });
    const first = await insertClaim({ db: f.db }, claimInput(external, { producer: "model", confidence: 0.2 }));
    if (first.outcome !== "stored") throw new Error("fixture claim was not stored");
    const before = getClaim(f.db, first.claim.claim_id);
    const retrieval = new FixtureVectorPort();
    for (const claimedProducer of ["model", "deterministic", "owner", "agent:fixture"] as const) {
      await expect(insertClaim({ db: f.db, retrieval }, claimInput(self, { producer: claimedProducer,
        confidence: 1, body: "Copied output corroborates the earlier claim." }))).rejects.toThrow("machine origin");
      expect(getClaim(f.db, first.claim.claim_id)).toEqual(before);
    }
    expect(retrieval.docs.size).toBe(0);
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 1 });
    expect(pendingRetrievalOps(f.db)).toEqual([]);
  } finally { f.close(); }
});

test("historical self-backed claims are excluded from later known-claim context", async () => {
  const f = fixture();
  try {
    const external = putEvent(f.db);
    const self = putEvent(f.db, { text: "KIZUKI CONTEXT v1\nsynthetic copied output" });
    const first = await insertClaim({ db: f.db }, claimInput(external, { subject: "person:ada", producer: "deterministic" }));
    if (first.outcome !== "stored") throw new Error("fixture claim was not stored");
    // Characterize a legacy claim written before the all-producer origin fence.
    f.db.query("UPDATE claims SET provenance=? WHERE claim_id=?").run(JSON.stringify([self]), first.claim.claim_id);
    let seenKnown = -1;
    const model: ProducerPort = { ...producer([], { count: 0 }), produce: async input => {
      seenKnown = input.context.known_claims.length;
      return { status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } };
    } };
    await runWritePass(f.db, f.path, { producer: model, model_ref: "fixture:atomic", claims: { db: f.db },
      budget: createBudgetTracker({ canon_writes_per_run: 8 }) });
    expect(seenKnown).toBe(0);
    expect(f.db.query("SELECT count(*) AS n FROM canon_receipts").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test("a purge during retrieval publication cancels the stale document and retries failed removal", async () => {
  const f = fixture();
  try {
    const event = putEvent(f.db);
    class PurgingPort extends FixtureVectorPort {
      failRemoval = true;
      override async upsert(docs: readonly RetrievalDoc[]) {
        // The port finishes an already-issued write after the public purge commits.
        purgeEvents(f.db, f.path, { event_id: event }, "owner-request", { retrieval_store: this.descriptor.id });
        await Promise.resolve();
        return super.upsert(docs);
      }
      override async remove(ids: readonly string[]) {
        if (this.failRemoval) throw new Error("synthetic removal unavailable");
        return super.remove(ids);
      }
    }
    const retrieval = new PurgingPort();
    const result = await insertClaim({ db: f.db, retrieval }, claimInput(event));
    if (result.outcome !== "stored") throw new Error("fixture claim was not stored");
    expect(getClaim(f.db, result.claim.claim_id)?.status).toBe("purged");
    expect(pendingRetrievalOps(f.db)).toHaveLength(1);
    expect(retrieval.docs.has(`claim:${result.claim.claim_id}`)).toBe(true);
    f.reopen();
    retrieval.failRemoval = false;
    expect(await retryRetrievalOps({ db: f.db, retrieval })).toEqual({ retried: 1, pending: 0 });
    expect(retrieval.docs.size).toBe(0);
    expect(f.db.query("SELECT state FROM retrieval_ops").all()).toEqual([{ state: "cancelled" }]);
  } finally { f.close(); }
});

test("a retrieval retry leaves another store's queued work pending", async () => {
  const f = fixture();
  try {
    const event = putEvent(f.db);
    const result = await insertClaim({ db: f.db }, claimInput(event));
    if (result.outcome !== "stored") throw new Error("fixture claim was not stored");
    const retrieval = new FixtureVectorPort();
    f.db.query("INSERT INTO retrieval_ops(op_id,store,op,doc_id,state,created_at) VALUES (?,?, 'upsert',?, 'pending',?)")
      .run("fixture-other-store-op", "test.other-store", result.claim.claim_id, "2026-09-05T00:00:00.000Z");
    expect(await retryRetrievalOps({ db: f.db, retrieval })).toEqual({ retried: 0, pending: 0 });
    expect(pendingRetrievalOps(f.db)).toEqual([{ op_id: "fixture-other-store-op", doc_id: result.claim.claim_id }]);
    expect(retrieval.docs.size).toBe(0);
  } finally { f.close(); }
});

test("public insertion and retrieval refuse an enclosing uncommitted transaction", async () => {
  const f = fixture();
  try {
    const event = putEvent(f.db);
    const retrieval = new FixtureVectorPort();
    f.db.exec("BEGIN IMMEDIATE");
    await expect(insertClaim({ db: f.db, retrieval }, claimInput(event))).rejects.toThrow("top-level transaction");
    await expect(retryRetrievalOps({ db: f.db, retrieval })).rejects.toThrow("requires committed claims");
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
    expect(retrieval.docs.size).toBe(0);
    f.db.exec("ROLLBACK");
  } finally { f.close(); }
});
