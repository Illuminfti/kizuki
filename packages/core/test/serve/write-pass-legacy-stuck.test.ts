import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { exportVault, restoreVault } from "../../src/export";
import { createBudgetTracker } from "../../src/canon/budget";
import { getClaim } from "../../src/claims/store";
import type { ProducerPort } from "../../src/contracts/producer";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { listQuarantinedClaims, recordStuckClaim, QUARANTINE_MS } from "../../src/serve/write-quarantine";
import { writeRailCursor } from "../../src/ledger/checkpoints";
import { runPurge } from "../../src/ledger/purge";
import { openLedger } from "../../src/ledger/db";
import { tempVault } from "../helpers/vault";
import { runWritePass } from "../../src/serve/write-pass";
import { canonFixture, putEvent, storeClaim, type CanonFixture } from "../canon/helpers";
import { eventFacts } from "../claims/helpers";

const fixtures: CanonFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const producer: ProducerPort = {
  descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
  health: async () => ({ status: "ready", detail: {} }), close: async () => {},
  produce: async () => ({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 }, dropped: [] }),
};

test("oversized legacy entity provenance stays intact while later writable claims make progress", async () => {
  const f = canonFixture(); fixtures.push(f);
  const events = Array.from({ length: 101 }, () => putEvent(f.db));
  const stuck = [];
  for (let i = 0; i < 33; i++) {
    stuck.push(await storeClaim(f.db, events[0]!, {
      kind: "entity", target: `topics/stuck-${i}`, subject: `topic:stuck-${i}`, subjects: [`topic:stuck-${i}`],
      predicate: null, object: null, body: `Referenced topic ${i}.`, frontmatter: { type: "topic", title: `Topic ${i}` },
      provenance: events, events: events.map(id => eventFacts(id)),
    }));
  }
  const healthy = await storeClaim(f.db, events[0]!);
  let clock = Date.parse("2026-03-01T00:00:00.000Z");
  const pass = () => runWritePass(f.db, f.vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 32 }), model_ref: "fixture/model", producer, claims: { db: f.db },
    now: () => new Date(clock).toISOString(),
  });
  for (let i = 0; i < 3; i++) {
    const report = await pass();
    expect(report.canon_writes).toBe(0);
    expect(report.errors.filter(e => e.includes("sources: exceeds 100 items"))).toHaveLength(32);
    clock += 60_000;
  }
  expect(listQuarantinedClaims(f.db, new Date(clock).toISOString()).claims).toHaveLength(32);
  const doctor = inspectServeDoctor(f.db, f.vault, { now: new Date(clock).toISOString() });
  expect(doctor.quarantined.claims).toHaveLength(32);
  expect(doctor.quarantined.detail).toContain("unmaterialized legacy claims=32");
  const fourth = await pass();
  expect(fourth.canon_writes).toBe(1);
  expect(getClaim(f.db, healthy.claim_id)?.receipt_id).not.toBeNull();
  expect(fourth.errors).toHaveLength(1);
  for (const item of stuck) {
    const stored = getClaim(f.db, item.claim_id)!;
    expect(stored.status).toBe("live");
    expect(stored.receipt_id).toBeNull();
    expect(stored.provenance).toEqual(events);
  }
}, 120_000);


test("legacy quarantine survives reopening, expires for retry, and clears only after a real write", async () => {
  const vault = tempVault("kizuki-legacy-retry-");
  const path = join(vault.path, ".kizuki", "kizuki.db");
  let db = openLedger(path);
  try {
    const event = putEvent(db);
    const claim = await storeClaim(db, event);
    const at = "2026-03-01T00:00:00.000Z";
    for (let i = 0; i < 3; i++) recordStuckClaim(db, claim.claim_id, "synthetic file failure", at);
    db.close(); db = openLedger(path);
    const pass = (now: string) => runWritePass(db, vault.path, { budget: createBudgetTracker({ canon_writes_per_run: 32 }),
      model_ref: "fixture/model", producer, claims: { db }, now: () => now });
    expect((await pass(at)).canon_writes).toBe(0);
    expect(getClaim(db, claim.claim_id)?.receipt_id).toBeNull();
    const after = new Date(Date.parse(at) + QUARANTINE_MS).toISOString();
    expect((await pass(after)).canon_writes).toBe(1);
    expect(getClaim(db, claim.claim_id)?.receipt_id).not.toBeNull();
    expect(listQuarantinedClaims(db, after).claims).toEqual([]);
    expect(db.query("SELECT 1 FROM canon_claim_retries WHERE claim_id=?").get(claim.claim_id)).toBeNull();
  } finally { db.close(); vault.dispose(); }
});

test("held claims are filtered before the queue limit, while malformed and dead holds have no effect", async () => {
  const f = canonFixture(); fixtures.push(f);
  const event = putEvent(f.db), at = "2026-03-01T00:00:00.000Z";
  for (let i = 0; i < 257; i++) {
    const claim = await storeClaim(f.db, event, { target: `people/held-${i}`, subject: `person:held-${i}`,
      subjects: [`person:held-${i}`], body: `Held person ${i}.` });
    for (let j = 0; j < 3; j++) recordStuckClaim(f.db, claim.claim_id, "synthetic failure", at);
  }
  const healthy = await storeClaim(f.db, event);
  writeRailCursor(f.db, "kizuki.canon.writer", `legacy:${healthy.claim_id}`, JSON.stringify({ attempts: 3, reason: "ignored", last_at: at, forged: true }));
  const result = await runWritePass(f.db, f.vault, { budget: createBudgetTracker({ canon_writes_per_run: 32 }),
    model_ref: "fixture/model", producer, claims: { db: f.db }, now: () => at });
  expect(result.canon_writes).toBe(1);
  expect(result.errors).toEqual([]);
  expect(getClaim(f.db, healthy.claim_id)?.receipt_id).not.toBeNull();
  const held = listQuarantinedClaims(f.db, at).claims;
  expect(held).toHaveLength(257);
  f.db.query("UPDATE claims SET status='purged' WHERE claim_id=?").run(held[0]!.claim_id);
  expect(listQuarantinedClaims(f.db, at).claims).toHaveLength(256);
  const marker = "synthetic-secret-value-1234567890";
  recordStuckClaim(f.db, held[1]!.claim_id, `secret=${marker} ${"failure ".repeat(50)}`, at);
  const row = inspectServeDoctor(f.db, f.vault, { now: at }).quarantined.claims!.find(c => c.claim_id === held[1]!.claim_id)!;
  expect(row.reason).not.toContain(marker);
  expect(row.reason.length).toBeLessThanOrEqual(200);
}, 120_000);


test("purge erases private retry state and cannot revive an unmaterialized claim", async () => {
  const f = canonFixture(); fixtures.push(f);
  const event = putEvent(f.db), at = "2026-03-01T00:00:00.000Z";
  // Imported legacy claim IDs are not restricted to newly generated ULIDs.
  const claim = await storeClaim(f.db, event, { claim_id: "legacy-fixture-claim" });
  for (let i = 0; i < 3; i++) recordStuckClaim(f.db, claim.claim_id, "synthetic failure", at);
  const other = await storeClaim(f.db, putEvent(f.db), { target: "people/unrelated", subject: "person:unrelated", subjects: ["person:unrelated"], body: "Unrelated retained evidence." });
  for (let i = 0; i < 3; i++) recordStuckClaim(f.db, other.claim_id, "frontmatter_invalid", at);
  expect(listQuarantinedClaims(f.db, at).claims).toHaveLength(2);
  await runPurge(f.db, f.vault, { event_id: event }, "synthetic erasure");
  expect(listQuarantinedClaims(f.db, at).claims.map(c => c.claim_id)).toEqual([other.claim_id]);
  expect(f.db.query("SELECT 1 FROM canon_claim_retries WHERE claim_id=?").get(claim.claim_id)).toBeNull();
  expect(getClaim(f.db, claim.claim_id)?.status).toBe("purged");
  expect(getClaim(f.db, claim.claim_id)?.body).toBe("");
  const root = mkdtempSync(join(tmpdir(), "kizuki-legacy-purge-backup-"));
  try {
    const backup = join(root, "backup"), target = join(root, "restored");
    exportVault(f.db, f.vault, backup); restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      expect(restored.query("SELECT 1 FROM canon_claim_retries WHERE claim_id=?").get(claim.claim_id)).toBeNull();
      expect(listQuarantinedClaims(restored, at).claims.map(c => c.claim_id)).toEqual([other.claim_id]);
    } finally { restored.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("historical claim identities beyond cursor and payload bounds retain independent retry state", async () => {
  const f = canonFixture(); fixtures.push(f);
  const event = putEvent(f.db), at = "2026-03-01T00:00:00.000Z";
  const ids = ["historical-" + "a".repeat(122), "historical-" + "a".repeat(9000), "historical-" + "a".repeat(9000) + "b"];
  for (const [index, claim_id] of ids.entries()) {
    const claim = await storeClaim(f.db, event, { claim_id, target: `people/long-${index}`,
      subject: `person:long-${index}`, subjects: [`person:long-${index}`], body: `Distinct historical person ${index}.` });
    for (let attempt = 0; attempt < 3; attempt++) recordStuckClaim(f.db, claim.claim_id, "frontmatter_invalid", at);
  }
  expect(f.db.query<{ claim_id: string }, []>("SELECT claim_id FROM canon_claim_retries ORDER BY claim_id").all().map(row => row.claim_id)).toEqual([...ids].sort());
  expect(listQuarantinedClaims(f.db, at).claims.map(row => row.claim_id)).toEqual([ids[0]!]);
  expect(listQuarantinedClaims(f.db, at).truncated).toBe(true);
  const doctor = inspectServeDoctor(f.db, f.vault, { now: at });
  expect(doctor.quarantined.claims_truncated).toBe(true);
  expect(doctor.quarantined.detail).toContain("claims shown=1 (truncated)");
  expect(JSON.stringify(doctor.quarantined)).not.toContain(ids[1]!);
  expect((await runWritePass(f.db, f.vault, { budget: createBudgetTracker({ canon_writes_per_run: 32 }),
    model_ref: "fixture/model", producer, claims: { db: f.db }, now: () => at })).canon_writes).toBe(0);
});

test("more than ten thousand held claims cannot starve a later writable claim", async () => {
  const f = canonFixture(); fixtures.push(f);
  const event = putEvent(f.db), at = "2026-03-01T00:00:00.000Z";
  const healthy = await storeClaim(f.db, event);
  const template = f.db.query<Record<string, string | number | null>, [string]>("SELECT * FROM claims WHERE claim_id=?").get(healthy.claim_id)!;
  const columns = Object.keys(template);
  const insert = f.db.query(`INSERT INTO claims (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  f.db.transaction(() => {
    for (let index = 0; index < 10_033; index++) {
      const claim_id = `held-${String(index).padStart(5, "0")}`;
      const row = { ...template, claim_id, claim_key: null, target: `people/${claim_id}`, created_at: "2026-01-01T00:00:00.000Z" };
      insert.run(...columns.map(column => row[column as keyof typeof row]));
      for (let attempt = 0; attempt < 3; attempt++) recordStuckClaim(f.db, claim_id, "frontmatter_invalid", at);
    }
  })();
  const report = await runWritePass(f.db, f.vault, { budget: createBudgetTracker({ canon_writes_per_run: 32 }),
    model_ref: "fixture/model", producer, claims: { db: f.db }, now: () => at });
  expect(report.claims_written).toBe(1);
  expect(getClaim(f.db, healthy.claim_id)?.receipt_id).not.toBeNull();
  const doctor = inspectServeDoctor(f.db, f.vault, { now: at });
  expect(doctor.quarantined.claims).toHaveLength(10_000);
  expect(doctor.quarantined.detail).toContain("claims shown=10000 (truncated)");
  expect(doctor.quarantined.claims_truncated).toBe(true);
}, 120_000);
