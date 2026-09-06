import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accept, bindSourceModelPort, createModelProducerPort, initVault, insertClaim, listClaims,
  MODEL_PRODUCER_DESCRIPTOR, MODEL_PRODUCER_ID, readRailCursor,
  registerConnection, runRail, setSourceGrant,
} from "../../src/index";
import type { CaptureEvent, ClaimDraft, LlmPort, LlmRequest, ProduceInput, ProducerPort } from "../../src/index";
import { openLedger } from "../../src/ledger/db";
import { ulid } from "../../src/util/ulid";
import { mineLiveDrafts } from "../../src/serve/extract";

const endpoint = "https://synthetic.example.test/v1/chat/completions";
const modelRef = "kizuki.llm.synthetic:budget@synthetic.example.test";
const remote = { model_endpoint: endpoint, model: "synthetic-budget", external_retention: "provider_managed" };
const policy = (allowed = true) => ({ purposes: ["capture", "recall", "derive", "extract", "export"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
  egress: allowed ? remote : "local_only", sensitivity_floor: "private" });

interface Fixture { path: string; database: string; db: ReturnType<typeof openLedger>; events: CaptureEvent[]; producers: ProducerPort[] }
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const producer of f.producers) await producer.close();
    f.db.close(); rmSync(f.path, { recursive: true, force: true });
  }
});

function fixture(): Fixture {
  const path = mkdtempSync(join(tmpdir(), "kizuki-extract-budget-"));
  initVault(path);
  const database = join(path, ".kizuki/kizuki.db");
  const f = { path, database, db: openLedger(database), events: [] as CaptureEvent[], producers: [] as ProducerPort[] };
  fixtures.push(f);
  return f;
}

function source(f: Fixture, allowed = true) {
  const id = ulid(); registerConnection(f.db, "kizuki.fixture", id);
  setSourceGrant(f.db, { source_key: id, expected_revision: 0, operation_id: `grant-${id}`, policy: policy(allowed) });
  return id;
}

function capture(f: Fixture, sourceKey: string, chars = 3_000, subjects = 16, display = 120, subjectId?: string) {
  const index = f.events.length;
  const opening = `Synthetic member ${index} reports serving as coordinator for the Saffron catalog. `;
  const result = accept(f.db, { schema: "kizuki.event/v1", connector_id: "kizuki.fixture", source_record_id: `record-${index}`,
    kind: "message", occurred_at: "2026-08-01T00:00:00Z", observed_at: "2026-08-02T00:00:00Z",
    text: opening + "x".repeat(chars - opening.length),
    subjects: Array.from({ length: subjects }, (_, subject) => ({ subject_id: subjectId ?? `fixture:person-${index}-${subject}`,
      role: subject === 0 ? "from" as const : "to" as const, display_name: `Person ${index} ${subject} `.padEnd(display, "m") })),
    sensitivity_hint: "private", deleted: false, attachments: [], metadata: {},
  }, { source: { source_key: sourceKey, expected_revision: 1 } });
  if (result.status !== "stored") throw new Error("synthetic capture failed");
  f.events.push(result.event); return result.event;
}

function reopen(f: Fixture) { f.db.close(); f.db = openLedger(f.database); }
const cursor = (f: Fixture) => readRailCursor(f.db, MODEL_PRODUCER_ID, "extract");
const deferred = (f: Fixture) => f.db.query<{ event_id: string }, []>("SELECT event_id FROM extract_deferred_inputs ORDER BY event_id").all().map(row => row.event_id);
const scan = (f: Fixture) => readRailCursor(f.db, MODEL_PRODUCER_ID, "extract-deferred-scan");

function model(f: Fixture, options: { abstain?: boolean; beforeComplete?: () => void; malformed?: boolean } = {}) {
  const requests: { ids: string[]; input_tokens: number; output_tokens: number; content: string }[] = [];
  const inputs: ProduceInput[] = [];
  const llm: LlmPort = { descriptor: { id: "kizuki.llm.synthetic", kind: "llm", contract: "kizuki.llm/v1", contract_minor: 0,
    supports: ["chat"], requires_lease: false, optional_package: null }, model_ref: modelRef,
    health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    async complete(request: LlmRequest) {
      const ids = [...request.messages[1]!.content.matchAll(/<<<KZ-QUOTE [0-9a-f]{32} event:([A-Za-z0-9:_.-]+)>>>/g)].map(match => match[1]!);
      requests.push({ ids, input_tokens: Math.ceil(request.messages.reduce((sum, message) => sum + message.content.length, 0) / 4), output_tokens: request.max_output_tokens,
        content: request.messages.map(message => message.content).join("\n") });
      options.beforeComplete?.();
      const claims: ClaimDraft[] = options.abstain ? [] : ids.map(id => {
        const event = f.events.find(item => item.event_id === id)!;
        return { kind: "claim", subject: event.subjects[0]!.subject_id, predicate: "employment.role", object: "Saffron catalog coordinator",
          polarity: "positive", body: `The Saffron catalog is coordinated by synthetic member ${event.source_record_id}.`,
          valid_from: null, valid_to: null, confidence: 0.8, sensitivity: "private", event_ids: [id] };
      });
      return { text: options.malformed ? "invalid synthetic JSON" : JSON.stringify({ claims }), model: "synthetic-budget", usage: { input_tokens: 1, output_tokens: 1 } };
    } };
  const dataDir = join(f.path, ".kizuki/producer-fixture"); mkdirSync(dataDir, { recursive: true });
  const actual = createModelProducerPort({ vault_path: f.path, data_dir: dataDir, config: {}, secrets: async () => { throw new Error("no fixture credentials"); },
    clock: () => "2026-09-05T00:00:00Z", logger: () => {}, }, { llm });
  f.producers.push(actual);
  const producer = bindSourceModelPort<ProducerPort>({ descriptor: MODEL_PRODUCER_DESCRIPTOR, health: () => actual.health(), close: () => actual.close(),
    async produce(input) { inputs.push(input); return actual.produce(input); } }, { model_endpoint: endpoint, model: "synthetic-budget" });
  return { producer, inputs, requests, options,
    run: () => runRail(f.db, f.path, "sync", { hooks: { producer, model_ref: modelRef, claims: { db: f.db } } }) };
}

test("a fitting frontier prefix defers only its interleaved denied events and leaves the raw suffix", async () => {
  const f = fixture(), allowed = source(f), held = source(f, false);
  const deniedFirst = capture(f, held, 200, 1, 12), first = capture(f, allowed), deniedSecond = capture(f, held, 200, 1, 12);
  const rest = Array.from({ length: 5 }, () => capture(f, allowed));
  const runner = model(f, { abstain: true });
  expect((await runner.run()).errors).toEqual([]);
  const selected = [first, ...rest.slice(0, 3)].map(event => event.event_id);
  expect(runner.requests[0]!.ids).toEqual(selected);
  expect(cursor(f)?.endsWith(selected.at(-1)!)).toBe(true);
  expect(deferred(f)).toEqual([deniedFirst.event_id, deniedSecond.event_id].sort());
  reopen(f);
  expect((await runner.run()).errors).toEqual([]);
  expect(runner.requests[1]!.ids).toEqual(rest.slice(3).map(event => event.event_id));
  expect(runner.inputs.flatMap(input => input.events.map(event => event.event_id))).not.toContain(deniedFirst.event_id);
  setSourceGrant(f.db, { source_key: held, expected_revision: 1, operation_id: "grant-held-frontier", policy: policy() });
  expect((await runner.run()).errors).toEqual([]);
  expect(runner.requests[2]!.ids).toEqual([deniedFirst.event_id, deniedSecond.event_id].sort());
  expect(deferred(f)).toEqual([]);
});

test("a failed deferred prefix retains its scan and all unprocessed rows across restart", async () => {
  const f = fixture(), held = source(f, false), events = Array.from({ length: 8 }, () => capture(f, held));
  const runner = model(f, { abstain: true, malformed: true });
  expect((await runner.run()).model.calls).toBe(0);
  expect(deferred(f)).toEqual(events.map(event => event.event_id).sort());
  setSourceGrant(f.db, { source_key: held, expected_revision: 1, operation_id: "grant-held-deferred", policy: policy() });
  const frontier = cursor(f), beforeScan = scan(f);
  expect((await runner.run()).claims_rejected.schema_invalid).toBe(1);
  expect(scan(f)).toBe(beforeScan);
  expect(deferred(f)).toHaveLength(8);
  const firstIds = runner.requests[0]!.ids;
  expect(firstIds).toEqual(events.slice(0, 4).map(event => event.event_id));
  reopen(f); runner.options.malformed = false;
  expect((await runner.run()).errors).toEqual([]);
  expect(runner.requests[1]!.ids).toEqual(firstIds);
  expect(scan(f)).toBe(firstIds.at(-1)!);
  expect(deferred(f)).toEqual(events.slice(4).map(event => event.event_id));
  expect(cursor(f)).toBe(frontier);
  expect((await runner.run()).errors).toEqual([]);
  expect(runner.requests[2]!.ids).toEqual(events.slice(4).map(event => event.event_id));
  expect(deferred(f)).toEqual([]);
});

for (const deferredMode of [false, true]) test(`an interrupted prefix replays its durable manifest atomically before its tail, deferred=${deferredMode}`, async () => {
  const f = fixture(), owned = source(f, !deferredMode), events = Array.from({ length: 8 }, () => capture(f, owned));
  const runner = model(f);
  if (deferredMode) {
    expect((await runner.run()).model.calls).toBe(0);
    setSourceGrant(f.db, { source_key: owned, expected_revision: 1, operation_id: "grant-before-partial", policy: policy() });
  }
  const priorCursor = cursor(f), priorScan = scan(f);
  f.db.exec("CREATE TRIGGER fail_second_budget_claim BEFORE INSERT ON claims WHEN NEW.subject='fixture:person-1-0' BEGIN SELECT RAISE(ABORT,'synthetic prefix interruption'); END");
  expect((await runner.run()).errors.length).toBeGreaterThan(0);
  expect(runner.requests).toHaveLength(1);
  expect(listClaims(f.db, { limit: 20 }).filter(claim => claim.producer === "model")).toHaveLength(0);
  const journal = f.db.query<{ input_ids: string; model_inputs: string; deferred_inputs: string; batch_mode: string }, []>("SELECT input_ids,model_inputs,deferred_inputs,batch_mode FROM extract_batches").get()!;
  expect(JSON.parse(journal.input_ids)).toEqual(events.slice(0, 4).map(event => event.event_id));
  expect(JSON.parse(journal.model_inputs).map((input: { event_id: string }) => input.event_id)).toEqual(JSON.parse(journal.input_ids));
  expect(journal.deferred_inputs).toBe("[]");
  expect(journal.batch_mode).toBe(deferredMode ? "deferred" : "frontier");
  expect(cursor(f)).toBe(priorCursor);
  expect(scan(f)).toBe(priorScan);
  reopen(f); f.db.exec("DROP TRIGGER fail_second_budget_claim");
  setSourceGrant(f.db, { source_key: owned, expected_revision: deferredMode ? 2 : 1, operation_id: "permission-preserving-replay-revision",
    policy: { ...policy(), purposes: [...policy().purposes, "audit"] } });
  expect((await runner.run()).errors).toEqual([]);
  expect(runner.requests).toHaveLength(1);
  expect(f.db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
  expect(listClaims(f.db, { limit: 20 }).filter(claim => claim.producer === "model")).toHaveLength(4);
  if (deferredMode) {
    expect(cursor(f)).toBe(priorCursor);
    expect(scan(f)).toBe(events[3]!.event_id);
    expect(deferred(f)).toEqual(events.slice(4).map(event => event.event_id));
  } else expect(cursor(f)?.endsWith(events[3]!.event_id)).toBe(true);
  expect((await runner.run()).errors).toEqual([]);
  expect(runner.requests[1]!.ids).toEqual(events.slice(4).map(event => event.event_id));
  expect(listClaims(f.db, { limit: 20 }).filter(claim => claim.producer === "model")).toHaveLength(8);
});

test("a source revision change during a prefix call cannot file or advance its input", async () => {
  const f = fixture(), owned = source(f), events = Array.from({ length: 8 }, () => capture(f, owned));
  let changed = false;
  const runner = model(f, { beforeComplete: () => {
    if (changed) return; changed = true;
    setSourceGrant(f.db, { source_key: owned, expected_revision: 1, operation_id: "revision-during-budget-call",
      policy: { ...policy(), purposes: [...policy().purposes, "audit"] } });
  } });
  expect((await runner.run()).stopped).toContain("source authorization unavailable");
  expect(cursor(f)).toBeNull();
  expect(f.db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
  expect(listClaims(f.db, { limit: 20 })).toEqual([]);
  reopen(f);
  expect((await runner.run()).errors).toEqual([]);
  expect(runner.requests.map(request => request.ids)).toEqual([events.slice(0, 4).map(event => event.event_id), events.slice(0, 4).map(event => event.event_id)]);
  expect(cursor(f)?.endsWith(events[3]!.event_id)).toBe(true);
});

test("denied claims cannot fill the subject limit ahead of an authorized claim in the actual prompt", async () => {
  const f = fixture(), held = source(f, false), owned = source(f);
  const denied = capture(f, held, 200, 1, 12, "fixture:shared-member");
  const allowed = capture(f, owned, 200, 1, 12, "fixture:shared-member");
  for (let index = 0; index < 33; index++) {
    const event = index < 32 ? denied : allowed;
    const object = index < 32 ? `Denied-tool-${index}` : "Authorized-tool";
    const stored = await insertClaim({ db: f.db, now: () => new Date(Date.UTC(2026, 8, 5, 0, 0, index)).toISOString() }, {
      kind: "claim", subject: "fixture:shared-member", predicate: "tool.uses", object,
      body: `The synthetic shared member uses ${object}.`, provenance: [event.event_id], subjects: ["fixture:shared-member"],
      producer: "model", model_ref: modelRef, confidence: 0.8, sensitivity: "private", taint: "quoted" });
    expect(stored.outcome).toBe("stored");
  }
  const runner = model(f, { abstain: true });
  expect((await mineLiveDrafts(f.db, runner.producer)).mined.status).toBe("empty");
  expect(runner.requests[0]!.ids).toEqual([allowed.event_id]);
  expect(runner.inputs[0]!.context.known_claims.map(claim => claim.object)).toEqual(["Authorized-tool"]);
  expect(runner.requests[0]!.content).toContain("Authorized-tool");
  expect(runner.requests[0]!.content).not.toContain("Denied-tool-");
});

test("every candidate prefix reselects authorized known claims before the shared context cap", async () => {
  const f = fixture(), owned = source(f);
  const expensive = capture(f, owned, 16_000, 1, 12, "fixture:z-member");
  async function seedContext(event: CaptureEvent, long: boolean) {
    for (let index = 0; index < 32; index++) {
      const stored = await insertClaim({ db: f.db }, { kind: "claim", subject: event.subjects[0]!.subject_id, predicate: "tool.uses",
        object: long ? `Long-${index}-`.padEnd(400, "z") : `Short-${index}`, body: `Synthetic known tool ${index} for ${event.subjects[0]!.subject_id}.`,
        provenance: [event.event_id], subjects: [event.subjects[0]!.subject_id], producer: "model", model_ref: modelRef,
        confidence: 0.8, sensitivity: "private", taint: "quoted" });
      expect(stored.outcome).toBe("stored");
    }
  }
  await seedContext(expensive, true);
  const runner = model(f, { abstain: true });
  expect((await mineLiveDrafts(f.db, runner.producer)).mined.status).toBe("rejected");
  expect(runner.requests).toHaveLength(0);
  const small = capture(f, owned, 200, 1, 12, "fixture:a-member");
  await seedContext(small, false);
  const result = await mineLiveDrafts(f.db, runner.producer);
  expect(result.mined.status).toBe("empty");
  expect(runner.requests[0]!.ids).toEqual([expensive.event_id, small.event_id]);
  expect(runner.inputs[1]!.context.known_claims).toHaveLength(32);
  expect(runner.inputs[1]!.context.known_claims.every(claim => claim.subject === "fixture:a-member")).toBe(true);
  expect(runner.requests[0]!.input_tokens).toBeLessThanOrEqual(8_000);
});

for (const abstain of [false, true]) test(`full prompt metadata selects a durable fitting prefix across restart, abstain=${abstain}`, async () => {
  const f = fixture(), owned = source(f);
  const events = Array.from({ length: 8 }, () => capture(f, owned));
  const first = model(f, { abstain });
  const receipt = await first.run();
  expect(receipt.errors).toEqual([]);
  expect(first.requests).toHaveLength(1);
  expect(first.requests[0]!.ids).toEqual(events.slice(0, 4).map(event => event.event_id));
  expect(first.requests[0]!.input_tokens).toBeLessThanOrEqual(8_000);
  expect(first.requests[0]!.output_tokens).toBe(2_000);
  expect(cursor(f)?.endsWith(events[3]!.event_id)).toBe(true);
  expect(deferred(f)).toEqual([]);
  reopen(f);
  const second = model(f, { abstain });
  expect((await second.run()).errors).toEqual([]);
  expect(second.requests[0]!.ids).toEqual(events.slice(4).map(event => event.event_id));
  expect(cursor(f)?.endsWith(events[7]!.event_id)).toBe(true);
  expect(listClaims(f.db, { limit: 20 }).filter(claim => claim.producer === "model")).toHaveLength(abstain ? 0 : 8);
  expect((await second.run()).model.calls).toBe(0);
});

test("text that requires two calls progresses one durable request at a time", async () => {
  const f = fixture(), owned = source(f), first = capture(f, owned, 12_001, 1, 12), second = capture(f, owned, 12_001, 1, 12);
  const runner = model(f);
  expect((await runner.run()).errors).toEqual([]);
  expect(runner.requests.map(request => request.ids)).toEqual([[first.event_id]]);
  expect(cursor(f)?.endsWith(first.event_id)).toBe(true);
  reopen(f);
  expect((await runner.run()).errors).toEqual([]);
  expect(runner.requests.map(request => request.ids)).toEqual([[first.event_id], [second.event_id]]);
  expect(listClaims(f.db, { limit: 20 }).filter(claim => claim.producer === "model")).toHaveLength(2);
});

for (const input of [{ chars: 24_001, subjects: 1, display: 12, rule: "max_quoted_chars" }, { chars: 24_000, subjects: 32, display: 256, rule: "max_input_tokens" }]) {
  test(`an impossible single record refuses without advancement, ${input.rule}`, async () => {
    const f = fixture(), owned = source(f); capture(f, owned, input.chars, input.subjects, input.display);
    const runner = model(f);
    for (let pass = 0; pass < 2; pass++) {
      const receipt = await runner.run();
      expect(receipt.status).toBe("degraded");
      expect(receipt.model.calls).toBe(0);
      expect(receipt.model.diagnostic).toMatchObject({ stage: "budget", rule: input.rule, used: 0 });
      expect(receipt.errors.join(" ")).toContain(input.rule);
      expect(cursor(f)).toBeNull();
      expect(deferred(f)).toEqual([]);
      expect(f.db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
      reopen(f);
    }
    expect(runner.requests).toHaveLength(0);
  });
}
