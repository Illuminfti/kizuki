import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import type { ProduceResult, ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { readExtractCursor, readDurableExtractBatch } from "../../src/serve/extract";
import { commitMachineByteIntent } from "../../src/ledger/event-origin";
import { sourcePortBindingDigest } from "../../src/ledger/source-grants";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { runRail } from "../../src/serve/rails";
import { runWritePass } from "../../src/serve/write-pass";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-extract-origin-"));
  directories.push(root);
  const path = join(root, "vault");
  initVault(path);
  return { path, db: openLedger(join(path, ".kizuki", "kizuki.db")) };
}

function producer(result: () => ProduceResult, calls: { value: number }): ProducerPort {
  return {
    descriptor: { id: "kizuki.producer.origin-test", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => undefined,
    produce: async () => { calls.value += 1; return result(); },
  };
}

test("self-only frontier advances without calling the producer", async () => {
  const { path, db } = fixture();
  const self = putEvent(db, { text: "KIZUKI CONTEXT v1\nsynthetic loop bytes" });
  const calls = { value: 0 };
  const receipt = await runRail(db, path, "sync", {
    hooks: {
      model_ref: "kizuki.llm.synthetic:origin-test",
      producer: producer(() => ({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }), calls),
      claims: { db },
    },
  });
  expect(calls.value).toBe(0);
  expect(receipt.claims_extracted).toBe(0);
  expect(readExtractCursor(db)).toContain(self);
  db.close();
});

test("a pending decision retains causally external drafts after a later intent without another model call", async () => {
  const { path, db } = fixture();
  const external = putEvent(db, { source_record_id: "origin-external" });
  const laterSelf = putEvent(db, { source_record_id: "origin-later-self" });
  const calls = { value: 0 };
  const draft = (event_ids: string[], subject: string) => ({
    kind: "claim" as const, subject, predicate: "employment.works_at", object: "Acme",
    polarity: "positive" as const, body: `${subject} works at Acme.`, valid_from: null,
    valid_to: null, confidence: 0.8, sensitivity: "personal" as const, event_ids,
  });
  const port = producer(() => ({ status: "ok", claims: [
    draft([external], "person:external"), draft([external, laterSelf], "person:mixed"),
  ], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }), calls);
  const options = { budget: createBudgetTracker({ canon_writes_per_run: 8 }), model_ref: "kizuki.llm.synthetic:origin-test", producer: port, claims: { db } };
  db.exec("CREATE TRIGGER fail_mixed BEFORE INSERT ON claims WHEN NEW.subject='person:mixed' BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END");
  await expect(runWritePass(db, path, options)).rejects.toThrow("synthetic interruption");
  expect(calls.value).toBe(1);
  db.exec("DROP TRIGGER fail_mixed");
  commitMachineByteIntent(db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex("Grace runs partnerships at Acme.") }, () => undefined);
  const replay = await runWritePass(db, path, options);
  expect(calls.value).toBe(1);
  expect(replay.errors).toEqual([]);
  expect(db.query("SELECT 1 FROM claims WHERE subject='person:mixed'").get()).not.toBeNull();
  expect(db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
  expect(readExtractCursor(db)).toContain(laterSelf);
  db.close();
});

test("a mixed self and external frontier files only the external draft", async () => {
  const { path, db } = fixture();
  try {
    putEvent(db, { source_record_id: "already-self", text: "KIZUKI CONTEXT v1 machine" });
    const external = putEvent(db, { source_record_id: "external", text: "Grace works at Acme." });
    const calls = { value: 0 };
    const port = producer(() => ({ status: "ok", claims: [{
      kind: "claim", subject: "person:grace", predicate: "employment.works_at", object: "Acme",
      polarity: "positive", body: "Grace works at Acme.", valid_from: null, valid_to: null,
      confidence: 0.8, sensitivity: "personal", event_ids: [external],
    }], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }), calls);
    const result = await runWritePass(db, path, { budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "fixture:origin", producer: port, claims: { db } });
    expect(result.errors).toEqual([]);
    expect(calls.value).toBe(1);
    expect(readExtractCursor(db)).toContain(external);
    expect(readDurableExtractBatch(db, port)).toBeNull();
  } finally { db.close(); }
});

test("a later intent preserves external deferred evidence and completes the original queue", async () => {
  const { path, db } = fixture();
  try {
    const external = putEvent(db, { source_record_id: "deferred-external", text: "Grace works at Acme." });
    const laterSelf = putEvent(db, { source_record_id: "deferred-later-self", text: "machine late bytes" });
    const calls = { value: 0 };
    const empty = producer(() => ({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }), calls);
    const options = { budget: createBudgetTracker({ canon_writes_per_run: 8 }), model_ref: "fixture:origin", claims: { db } };
    await runWritePass(db, path, { ...options, producer: empty });
    const checkpoint = readExtractCursor(db);
    const port = producer(() => {
      commitMachineByteIntent(db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex("machine late bytes") }, () => undefined);
      return { status: "ok", claims: [
        { kind: "claim", subject: "person:grace", predicate: "employment.works_at", object: "Acme", polarity: "positive", body: "Grace works at Acme.", valid_from: null, valid_to: null, confidence: 0.8, sensitivity: "personal", event_ids: [external] },
        { kind: "claim", subject: "person:late", predicate: "employment.works_at", object: "Acme", polarity: "positive", body: "Late works at Acme.", valid_from: null, valid_to: null, confidence: 0.8, sensitivity: "personal", event_ids: [laterSelf] },
      ], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } };
    }, calls);
    for (const id of [external, laterSelf]) db.query("INSERT INTO extract_deferred_inputs VALUES (?,NULL,0,?)")
      .run(id, sourcePortBindingDigest(port));
    const result = await runWritePass(db, path, { ...options, producer: port });
    expect(result.errors).toEqual([]);
    expect(db.query("SELECT 1 FROM extract_deferred_inputs").get()).toBeNull();
    expect(db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
    expect(db.query("SELECT 1 FROM claims WHERE subject='person:late'").get()).not.toBeNull();
    expect(db.query("SELECT 1 FROM claims WHERE subject='person:grace'").get()).not.toBeNull();
    expect(readExtractCursor(db)).toBe(checkpoint);
    expect(calls.value).toBe(2);
  } finally { db.close(); }
});
