import { Database } from "bun:sqlite";
import { initServe } from "../../src/serve/schema";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { initVault } from "../../src/vault/init";
import { runRail } from "../../src/serve/rails";
import { readExtractCursor } from "../../src/serve/extract";
import { listClaims } from "../../src/claims/store";
import { listRunReceipts } from "../../src/serve/receipts";
import type { ClaimDraft, ProducerPort } from "../../src/contracts/producer";
import { putEvent } from "../claims/helpers";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "kizuki-durability-")); dirs.push(path); initVault(path);
  writeFileSync(join(path, ".kizuki/serve.toml"), "[budget]\ncanon_writes_per_run = 0\n");
  const db = openLedger(join(path, ".kizuki/kizuki.db"));
  const a = putEvent(db, { source_record_id: "durable-a" });
  const b = putEvent(db, { source_record_id: "durable-b" });
  const draft = (id: string, subject: string): ClaimDraft => ({ kind: "claim", subject, predicate: "employment.works_at", object: "Acme", polarity: "positive", body: `${subject} works at Acme.`, valid_from: null, valid_to: null, confidence: .8, sensitivity: "personal", event_ids: [id] });
  let calls = 0;
  const producer: ProducerPort = {
    descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    produce: async () => { calls++; return { status: "ok", claims: [draft(a, "person:grace"), draft(b, "person:ada")], usage: { calls: 1, input_tokens: 101, output_tokens: 41 } }; },
  };
  return { path, db, a, b, producer, calls: () => calls, hooks: { producer, claims: { db }, model_ref: "model:A" } };
}
test("partial filing binds original model and reports actual usage once", async () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER fail_b BEFORE INSERT ON claims WHEN NEW.subject = 'person:ada' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const first = await runRail(f.db, f.path, "sync", { hooks: f.hooks });
  expect(first.model.calls).toBe(1); expect(first.model.input_tokens).toBe(101);
  f.db.exec("DROP TRIGGER fail_b");
  await runRail(f.db, f.path, "sync", { hooks: { ...f.hooks, model_ref: "model:B" } });
  expect(f.calls()).toBe(1);
  expect(listClaims(f.db, { limit: 20 }).map(c => c.model_ref)).toEqual(["model:A", "model:A"]);
  expect(listRunReceipts(f.db).reduce((n, r) => n + r.model.calls, 0)).toBe(1);
  f.db.close();
});
test("forged empty journal cannot skip real history", async () => {
  const f = fixture();
  f.db.query("INSERT INTO extract_batches(previous_cursor,cursor,drafts,model_ref,created_at) VALUES ('', ?, '[]', 'model:A', '2026-09-01')").run("2099-01-01T00:00:00Z\t01K2Z7ZQZK0R4E0RZ5C8QJ7X01");
  const receipt = await runRail(f.db, f.path, "sync", { hooks: f.hooks });
  expect(receipt.errors.length).toBeGreaterThan(0); expect(readExtractCursor(f.db)).toBeNull();
  expect(f.db.query("SELECT * FROM extract_batches").all()).toHaveLength(1);
  f.db.close();
});
test("purging an unfiled source removes only affected journal drafts and retry does not remine", async () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER fail_b BEFORE INSERT ON claims WHEN NEW.subject = 'person:ada' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await runRail(f.db, f.path, "sync", { hooks: f.hooks });
  f.db.exec("DROP TRIGGER fail_b");
  purgeEvents(f.db, f.path, { event_id: f.b }, "synthetic purge");
  const journal = JSON.stringify(f.db.query("SELECT * FROM extract_batches").all());
  expect(journal).not.toContain(f.b); expect(journal).not.toContain("person:ada works");
  const receipt = await runRail(f.db, f.path, "sync", { hooks: f.hooks });
  expect(receipt.errors).toEqual([]); expect(f.calls()).toBe(1);
  expect(listClaims(f.db, { status: "live", limit: 20 })).toHaveLength(1);
  f.db.close();
});
test("current schema open repairs additive runtime tables", () => {
  const f = fixture(); f.db.exec("DROP TABLE extract_batches"); f.db.close();
  const db = openLedger(join(f.path, ".kizuki/kizuki.db"));
  expect(db.query("SELECT name FROM sqlite_master WHERE name='extract_batches'").all()).toHaveLength(1); db.close();
});

test("concurrent rails admit at most one write at a daily cap of one", async () => {
  const f = fixture();
  writeFileSync(join(f.path, ".kizuki/serve.toml"), "[budget]\ncanon_writes_per_run = 1\ncanon_writes_per_day = 1\n");
  const { fileProposal } = await import("../../src/staging/proposals");
  for (const [id, subject] of [[f.a, "grace"], [f.b, "ada"]] as const) fileProposal(f.db, {
    kind: "claim", target: `people/${subject}`, body: `${subject} works at Acme.`, frontmatter: { type: "person", title: subject },
    provenance: [id], subjects: [`person:${subject}`], producer: "deterministic", confidence: .8,
  });
  const producer: ProducerPort = { ...f.producer, produce: async () => ({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 } }) };
  const first = Promise.withResolvers<void>(); const second = Promise.withResolvers<void>();
  const sync = (wait: Promise<void>) => async () => { await wait; return { events_synced: 0, events_stored: 0, events_duplicate: 0, events_self_skipped: 0, errors: [] }; };
  const one = runRail(f.db, f.path, "sync", { hooks: { ...f.hooks, producer, sync: sync(first.promise) } });
  const two = runRail(f.db, f.path, "sync", { hooks: { ...f.hooks, producer, sync: sync(second.promise) } });
  first.resolve(); const a = await one; second.resolve(); const b = await two;
  expect(a.canon_writes + b.canon_writes).toBe(1);
  expect(b.stopped).toBe("budget:canon_writes_per_day");
  expect(f.db.query<{ used: number }, []>("SELECT used FROM budget_ledger WHERE name='canon_writes_per_day'").get()?.used).toBe(1);
  f.db.close();
});

test("an unused interrupted reservation is released, a file effect remains charged", async () => {
  const f = fixture();
  const { createDurableWriteBudget, settleWriteReservations } = await import("../../src/serve/budget-ledger");
  const day = new Date().toISOString().slice(0, 10);
  const tracker = () => createDurableWriteBudget(f.db, f.path, day, { canon_writes_per_day: 1, canon_writes_per_run: 1 });
  tracker().chargeWrite({ receipt_id: "synthetic-before", page_path: "people/grace.md", before_hash: null });
  settleWriteReservations(f.db, f.path);
  expect(tracker().usage().canon_writes_per_day.used).toBe(0);
  tracker().chargeWrite({ receipt_id: "synthetic-after", page_path: "people/grace.md", before_hash: null });
  mkdirSync(join(f.path, "people"), { recursive: true });
  writeFileSync(join(f.path, "people/grace.md"), "synthetic interrupted bytes");
  settleWriteReservations(f.db, f.path);
  expect(tracker().usage().canon_writes_per_day.used).toBe(1);
  expect(() => tracker().chargeWrite({ receipt_id: "synthetic-denied", page_path: "people/ada.md", before_hash: null })).toThrow("exhausted");
  f.db.close();
});

for (const crashAfter of ["after-file", "after-jsonl", "after-db"] as const) test(`model usage is accounted once after ${crashAfter} receipt interruption`, async () => {
  const f = fixture();
  await expect(runRail(f.db, f.path, "sync", { hooks: f.hooks, crashAfter })).rejects.toThrow();
  await runRail(f.db, f.path, "sync", { hooks: { ...f.hooks, model_ref: "model:B" } });
  const receipts = listRunReceipts(f.db);
  expect(receipts.reduce((sum, r) => sum + r.model.calls, 0)).toBe(1);
  expect(receipts.find(r => r.model.calls === 1)?.model.model_ref).toBe("model:A");
  expect(f.calls()).toBe(1); f.db.close();
});

test("purge failure rolls the exact pending decision back with its source", async () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER fail_b BEFORE INSERT ON claims WHEN NEW.subject='person:ada' BEGIN SELECT RAISE(ABORT,'injected'); END");
  await runRail(f.db, f.path, "sync", { hooks: f.hooks });
  const before = f.db.query("SELECT * FROM extract_batches").all();
  f.db.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'injected purge'); END");
  expect(() => purgeEvents(f.db, f.path, { event_id: f.b }, "synthetic purge")).toThrow();
  expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual(before);
  expect(f.db.query("SELECT event_id FROM events WHERE event_id=?").get(f.b)).not.toBeNull();
  f.db.close();
});

test("purging the previous extraction checkpoint scrubs its ID without replaying completed inputs", async () => {
  const f = fixture();
  const empty: ProducerPort = { ...f.producer, produce: async () => ({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 } }) };
  await runRail(f.db, f.path, "sync", { hooks: { ...f.hooks, producer: empty } });
  const c = putEvent(f.db, { source_record_id: "durable-c" });
  const producer: ProducerPort = { ...f.producer, produce: async () => ({ status: "ok", claims: [{ kind: "claim", subject: "person:grace", predicate: "employment.works_at", object: "NewCo", polarity: "positive", body: "Grace works at NewCo.", valid_from: null, valid_to: null, confidence: .8, sensitivity: "personal", event_ids: [c] }], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }) };
  f.db.exec("CREATE TRIGGER fail_c BEFORE INSERT ON claims BEGIN SELECT RAISE(ABORT,'injected'); END");
  await runRail(f.db, f.path, "sync", { hooks: { ...f.hooks, producer } });
  f.db.exec("DROP TRIGGER fail_c");
  purgeEvents(f.db, f.path, { event_id: f.b }, "synthetic previous boundary purge");
  expect(JSON.stringify(f.db.query("SELECT * FROM extract_batches").all())).not.toContain(f.b);
  const retry = await runRail(f.db, f.path, "sync", { hooks: { ...f.hooks, producer: { ...empty, produce: async () => { throw new Error("must replay saved decision"); } } } });
  expect(retry.errors).toEqual([]); expect(readExtractCursor(f.db)).toContain(c); f.db.close();
});


test("an incompatible schedule rolls back every additive runtime table", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE schedules (unexpected TEXT)");
  expect(() => initServe(db)).toThrow();
  expect(db.query("SELECT name FROM sqlite_master WHERE name='extract_batches'").all()).toHaveLength(0);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='extract_usage'").all()).toHaveLength(0);
  db.close();
});

for (const corruption of ["integrity", "drafts"] as const) test(`owner purge discards corrupt ${corruption} with content-free audit`, async () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER fail_b BEFORE INSERT ON claims WHEN NEW.subject = 'person:ada' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await runRail(f.db, f.path, "sync", { hooks: f.hooks });
    f.db.exec(corruption === "integrity" ? "UPDATE extract_batches SET integrity='corrupt'" : "UPDATE extract_batches SET drafts='not json'");
    const corrupt = f.db.query("SELECT * FROM extract_batches").all();
    f.db.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'injected purge'); END");
    expect(() => purgeEvents(f.db, f.path, { event_id: f.b }, "synthetic purge")).toThrow();
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual(corrupt);
    expect(f.db.query("SELECT * FROM extract_invalidations").all()).toHaveLength(0);
    f.db.exec("DROP TRIGGER fail_purge");
    purgeEvents(f.db, f.path, { event_id: f.b }, "synthetic purge");
    expect(f.db.query("SELECT event_id FROM events WHERE event_id=?").all(f.b)).toHaveLength(0);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toHaveLength(0);
    const audit = f.db.query("SELECT * FROM extract_invalidations").all();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(f.b);
    expect(JSON.stringify(audit)).not.toContain("person:ada");
    expect(f.db.query("SELECT 1 FROM extract_invalidations i JOIN event_purges p ON i.purge_receipt_id=p.receipt_id").all()).toHaveLength(1);
    expect(readExtractCursor(f.db)).toBeNull();
    f.db.exec("DROP TRIGGER fail_b");
    const receipt = await runRail(f.db, f.path, "sync", { hooks: { ...f.hooks, producer: { ...f.producer, produce: async () => ({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 10, output_tokens: 1 } }) } } });
    expect(receipt.errors).toEqual([]);
    expect(listClaims(f.db, { status: "live", limit: 20 })).toHaveLength(1);
  } finally { f.db.close(); }
});

test("killed producer attempt is durable, uncertain and counted separately from retry", async () => {
  const f = fixture(); f.db.close();
  const base = new URL("../../src/", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "--eval", `
    const {openLedger}=await import(${JSON.stringify(base + "ledger/db.ts")});
    const {runRail}=await import(${JSON.stringify(base + "serve/rails.ts")});
    const db=openLedger(${JSON.stringify(join(f.path, ".kizuki/kizuki.db"))});
    const producer={descriptor:${JSON.stringify(f.producer.descriptor)},health:async()=>({status:"ready",detail:{}}),close:async()=>{},produce:async()=>{console.log("entered");await Bun.stdin.text();throw new Error("interrupted");}};
    await runRail(db,${JSON.stringify(f.path)},"sync",{hooks:{producer,claims:{db},model_ref:"model:original"}});
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("entered"); reader.releaseLock();
    child.kill("SIGKILL"); await child.exited;
    const db = openLedger(join(f.path, ".kizuki/kizuki.db"));
    try {
      expect(db.query("SELECT * FROM extract_usage").all()).toHaveLength(1);
      await runRail(db, f.path, "doctor-sweep");
      const interrupted = listRunReceipts(db).find(r => r.model.calls > 0)!;
      expect(interrupted.status).toBe("failed");
      expect(interrupted.model).toMatchObject({ calls: 1, model_ref: "model:original", usage_unknown: true });
      expect(interrupted.errors.join(" ")).toContain("unknown");
      const { inspectServeDoctor } = await import("../../src/serve/doctor");
      expect(inspectServeDoctor(db, f.path).model.last_success_at).toBeNull();
      expect(readExtractCursor(db)).toBeNull();
      await runRail(db, f.path, "sync", { hooks: { ...f.hooks, claims: { db } } });
      expect(listRunReceipts(db).reduce((n, r) => n + r.model.calls, 0)).toBe(2);
    } finally { db.close(); }
  } finally { child.kill(); await child.exited; }
}, 15_000);

test("once SIGTERM finishes active sync without starting brief", async () => {
  const f = fixture(); f.db.close();
  const base = new URL("../../src/", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "--eval", `
    const {openLedger}=await import(${JSON.stringify(base + "ledger/db.ts")});
    const {runServeDaemon}=await import(${JSON.stringify(base + "serve/daemon.ts")});
    const db=openLedger(${JSON.stringify(join(f.path, ".kizuki/kizuki.db"))});
    await runServeDaemon(db,${JSON.stringify(f.path)},{once:true,http:false,rails:["sync","brief"],hooks:{sync:async()=>{console.log("entered");await Bun.stdin.text();return {events_synced:0,events_stored:0,events_duplicate:0,events_self_skipped:0,errors:[]};}}});db.close();
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("entered"); reader.releaseLock();
    child.kill("SIGTERM");
    await Bun.sleep(30); child.stdin.end();
    expect(await child.exited).toBe(0);
    const db = openLedger(join(f.path, ".kizuki/kizuki.db"));
    try { expect(listRunReceipts(db).map(r => r.rail)).toEqual(["sync"]); } finally { db.close(); }
  } finally { child.kill(); await child.exited; }
}, 15_000);
