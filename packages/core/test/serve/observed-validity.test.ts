import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { insertClaim, listClaims } from "../../src/claims/store";
import { initVault } from "../../src/vault/init";
import { runRail } from "../../src/serve/rails";
import { journalExtractBatch, mineLiveDrafts, readExtractCursor } from "../../src/serve/extract";
import type { ClaimDraft, ProducerPort } from "../../src/contracts/producer";
import { validEvent } from "../fixtures";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const FILED_AT = "2026-09-05T12:00:00.000Z";
const RETRIED_AT = "2026-09-06T12:00:00.000Z";

function fixture(observations: readonly string[], makeDrafts?: (ids: string[]) => ClaimDraft[]) {
  const path = mkdtempSync(join(tmpdir(), "kizuki-observed-validity-"));
  dirs.push(path);
  initVault(path);
  writeFileSync(join(path, ".kizuki/serve.toml"), "[budget]\ncanon_writes_per_run = 0\n");
  const db = openLedger(join(path, ".kizuki/kizuki.db"));
  const ids = observations.map((observed_at, index) => {
    const result = accept(db, {
      ...validEvent(), source_record_id: `observation-${index}`,
      observed_at, occurred_at: "2016-01-01T00:00:00Z",
    });
    if (result.status !== "stored") throw new Error("observation fixture capture failed");
    return result.event.event_id;
  });
  const drafts = makeDrafts?.(ids) ?? [draft(ids)];
  let calls = 0;
  const producer: ProducerPort = {
    descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    produce: async () => {
      calls += 1;
      return { status: "ok", claims: drafts, usage: { calls: 1, input_tokens: 10, output_tokens: 10 } };
    },
  };
  const run = (at = FILED_AT) => runRail(db, path, "sync", {
    hooks: { producer, claims: { db, now: () => at }, model_ref: "fixture:historical" },
  });
  return { path, db, ids, drafts, producer, run, calls: () => calls };
}

function draft(ids: readonly string[], extra: Partial<ClaimDraft> = {}): ClaimDraft {
  return {
    kind: "claim", subject: "person:grace", predicate: "employment.works_at", object: "Acme",
    polarity: "positive", body: "Grace works at Acme.", valid_from: null, valid_to: null,
    confidence: .8, sensitivity: "personal", event_ids: [...ids], ...extra,
  };
}

test("historical extraction persists observed_at while asserted_at remains filing time", async () => {
  const observed = "2026-08-02T10:00:00-00:00";
  const f = fixture([observed]);
  try {
    expect((await f.run()).errors).toEqual([]);
    expect(listClaims(f.db, { limit: 20 })).toMatchObject([{
      valid_from: observed, valid_to: null, asserted_at: FILED_AT, provenance: f.ids,
    }]);
    expect(f.drafts[0]!.valid_from).toBeNull();
    expect(readExtractCursor(f.db)).not.toBeNull();
  } finally { f.db.close(); }
});

test("explicit model validity dates survive persistence byte for byte", async () => {
  const validity = { valid_from: "2026-01-01T00:00:00.0000001+00:00", valid_to: "2026-05-01T00:00:00Z" };
  const f = fixture(["2026-08-02T10:00:00Z"], ids => [draft(ids, validity)]);
  try {
    expect((await f.run()).errors).toEqual([]);
    expect(listClaims(f.db, { limit: 20 })).toMatchObject([{ ...validity, asserted_at: FILED_AT }]);
  } finally { f.db.close(); }
});

for (const reverse of [false, true]) test(`latest observation compares offsets and submillisecond fractions, reversed=${reverse}`, async () => {
  const expected = "2026-08-02T10:00:00.0000002Z";
  const observations = ["2026-08-02T12:00:00.0000001+02:00", expected];
  const f = fixture(observations, ids => [draft(reverse ? ids.toReversed() : ids)]);
  try {
    expect((await f.run()).errors).toEqual([]);
    expect(listClaims(f.db, { limit: 20 })[0]!.valid_from).toBe(expected);
  } finally { f.db.close(); }
});

for (const reverse of [false, true]) test(`equivalent observation spellings select stable source bytes, reversed=${reverse}`, async () => {
  const observations = ["2026-08-02T12:00:00+02:00", "2026-08-02t10:00:00.000z", "2026-08-02T10:00:00-00:00"];
  const f = fixture(observations, ids => [draft(reverse ? ids.toReversed() : ids)]);
  try {
    expect((await f.run()).errors).toEqual([]);
    expect(listClaims(f.db, { limit: 20 })[0]!.valid_from).toBe("2026-08-02T10:00:00-00:00");
  } finally { f.db.close(); }
});

for (const reverse of [false, true]) test(`an ordinary second follows its preceding leap second, reversed=${reverse}`, async () => {
  const expected = "2017-01-01T00:00:00.1Z";
  const f = fixture(["2016-12-31T23:59:60.9Z", expected], ids => [draft(reverse ? ids.toReversed() : ids)]);
  try {
    expect((await f.run()).errors).toEqual([]);
    expect(listClaims(f.db, { limit: 20 })[0]!.valid_from).toBe(expected);
  } finally { f.db.close(); }
});

test("a single leap-second observation is preserved", async () => {
  const observed = "2016-12-31T23:59:60.123456789Z";
  const f = fixture([observed]);
  try {
    expect((await f.run()).errors).toEqual([]);
    expect(listClaims(f.db, { limit: 20 })[0]!.valid_from).toBe(observed);
  } finally { f.db.close(); }
});

for (const legacy of [false, true]) test(`partial filing keeps raw nulls and replays observed times, legacy=${legacy}`, async () => {
  const observations = ["2026-07-01T12:00:00Z", "2026-08-01T12:00:00Z"];
  const f = fixture(observations, ids => [draft([ids[0]!]), draft([ids[1]!], { subject: "person:ada", body: "Ada works at Acme." })]);
  try {
    f.db.exec("CREATE TRIGGER fail_ada BEFORE INSERT ON claims WHEN NEW.subject='person:ada' BEGIN SELECT RAISE(ABORT,'injected filing interruption'); END");
    expect((await f.run()).errors.length).toBeGreaterThan(0);
    expect(listClaims(f.db, { limit: 20 })).toMatchObject([{ valid_from: observations[0], asserted_at: FILED_AT }]);
    const saved = f.db.query<{ drafts: string }, []>("SELECT drafts FROM extract_batches").get()!;
    expect(JSON.parse(saved.drafts).map((item: ClaimDraft) => item.valid_from)).toEqual([null, null]);
    expect(readExtractCursor(f.db)).toBeNull();
    if (legacy) f.db.exec("UPDATE extract_batches SET model_inputs=NULL,deferred_inputs=NULL,input_ids=NULL,integrity=NULL");
    f.db.exec("DROP TRIGGER fail_ada");
    expect((await f.run(RETRIED_AT)).errors).toEqual([]);
    expect(f.calls()).toBe(1);
    const claims = listClaims(f.db, { limit: 20 });
    expect(claims.find(claim => claim.subject === "person:grace")).toMatchObject({ valid_from: observations[0], asserted_at: FILED_AT });
    expect(claims.find(claim => claim.subject === "person:ada")).toMatchObject({ valid_from: observations[1], asserted_at: RETRIED_AT });
    expect(f.db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
    expect(readExtractCursor(f.db)).not.toBeNull();
  } finally { f.db.close(); }
});

test("legacy replay preserves an already filed row while fixing the remaining historical draft", async () => {
  const observations = ["2026-07-01T12:00:00Z", "2026-08-01T12:00:00Z"];
  const f = fixture(observations, ids => [draft([ids[0]!]), draft([ids[1]!], { subject: "person:ada", body: "Ada works at Acme." })]);
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.producer), "fixture:historical", f.producer);
    // This is the input emitted by the previous filing code: omitted validity
    // caused insertClaim to use the filing clock. Replay must not rewrite it.
    const old = await insertClaim({ db: f.db, now: () => FILED_AT }, {
      kind: "claim", subject: "person:grace", predicate: "employment.works_at", object: "Acme",
      polarity: "positive", body: "Grace works at Acme.", provenance: [f.ids[0]!], subjects: ["person:grace"],
      producer: "model", model_ref: "fixture:historical", confidence: .8, taint: "quoted", sensitivity: "personal",
    });
    expect(old.outcome).toBe("stored");
    const before = listClaims(f.db, { limit: 20 })[0]!;
    expect(before.valid_from).toBe(FILED_AT);
    f.db.exec("UPDATE extract_batches SET model_inputs=NULL,deferred_inputs=NULL,input_ids=NULL,integrity=NULL");
    expect((await f.run(RETRIED_AT)).errors).toEqual([]);
    const claims = listClaims(f.db, { limit: 20 });
    expect(claims.find(claim => claim.subject === "person:grace")).toEqual(before);
    expect(claims.find(claim => claim.subject === "person:ada")).toMatchObject({ valid_from: observations[1], asserted_at: RETRIED_AT });
    expect(f.calls()).toBe(1);
    expect(readExtractCursor(f.db)).not.toBeNull();
  } finally { f.db.close(); }
});
