import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createBudgetTracker } from "../../src/canon/budget";
import { listClaims } from "../../src/claims/store";
import {
  PRODUCER_V2_CONTRACT,
  type ProduceInputV2,
  type ProduceResultV2,
  type ProducerV2Port,
} from "../../src/contracts/producer-v2";
import { PortError } from "../../src/contracts/ports";
import { openLedger } from "../../src/ledger/db";
import { bindSourceModelPort } from "../../src/ledger/source-grants";
import { loadServeConfig } from "../../src/serve/config";
import { readExtractCursor, requeuePassedOverRecords } from "../../src/serve/extract";
import {
  backoffRemaining,
  readRejections,
  recordRejection,
  rejectionBackoffMs,
  writeRejections,
} from "../../src/serve/extract-rejections";
import { runRail } from "../../src/serve/rails";
import { listRunReceipts } from "../../src/serve/receipts";
import {
  DEFAULT_EXTRACTION_CONFIG,
  type ExtractionConfig,
} from "../../src/serve/types";
import { runWritePass } from "../../src/serve/write-pass";
import {
  ENDPOINT,
  MODEL,
  scriptedModelProducer,
  throughputVault,
  typedResponse,
  writeServeToml,
  type ThroughputVault,
} from "./throughput-fixture";

// Each pass opens a ledger and files claims; a loaded CI machine needs headroom.
setDefaultTimeout(30_000);

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function fixture(records: number): ThroughputVault & { db: Database } {
  const vault = throughputVault(records);
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  return { ...vault, db };
}

const limits = (fields: Partial<ExtractionConfig>): ExtractionConfig => ({
  ...DEFAULT_EXTRACTION_CONFIG,
  ...fields,
});
const modelClaims = (db: Database): number =>
  listClaims(db, { status: "live", limit: 1_000 }).filter(
    (claim) => claim.producer === "model",
  ).length;
const endsAt = (cursor: string | null, eventId: string): boolean =>
  cursor?.endsWith(`\t${eventId}`) === true;

const TRUNCATED = { stage: "response", rule: "response_truncated" } as const;

/**
 * A typed producer bound to the fixture grant. `verdict` decides each request
 * from the records it carries; a rejection is billed like a real one.
 */
function port(
  verdict: (
    ids: readonly string[],
    request: number,
  ) => "ok" | "truncated" | "bad_response",
) {
  const requests: string[][] = [];
  const producer = bindSourceModelPort<ProducerV2Port>(
    {
      descriptor: {
        id: "kizuki.producer.fixture-rejections",
        kind: "producer",
        contract: PRODUCER_V2_CONTRACT,
        contract_minor: 0,
        supports: ["model"],
        requires_lease: false,
        optional_package: null,
      },
      model_ref: MODEL,
      health: async () => ({ status: "ready", detail: {} }),
      close: async () => undefined,
      async produce(input: ProduceInputV2): Promise<ProduceResultV2> {
        const ids = input.events.map((event) => event.event_id);
        requests.push(ids);
        const answer = verdict(ids, requests.length);
        if (answer === "ok") {
          return {
            status: "ok",
            response: typedResponse(input.events),
            usage: { calls: 1, input_tokens: 10, output_tokens: 20 },
          };
        }
        return {
          status: "rejected",
          reason: "schema_invalid",
          usage: { calls: 1, input_tokens: 100, output_tokens: 600 },
          diagnostic:
            answer === "truncated"
              ? TRUNCATED
              : { stage: "response", rule: "bad_response" },
        };
      },
    },
    { model_endpoint: ENDPOINT, model: MODEL },
  );
  return { producer, requests };
}

function pass(
  f: { db: Database; vault: string },
  producer: ProducerV2Port,
  extraction: ExtractionConfig,
  now?: string,
) {
  return runWritePass(f.db, f.vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 0 }),
    producer,
    claims: { db: f.db },
    extraction,
    ...(now === undefined ? {} : { now: () => now }),
  });
}

const at = (minutes: number): string =>
  new Date(Date.UTC(2026, 8, 29, 0, 0, 0) + minutes * 60_000).toISOString();

test("at the default one call per pass a poison record is isolated and skipped across passes", async () => {
  const f = fixture(2);
  const [e0, e1] = f.eventIds as [string, string];
  // Rejects any request with more than one record, and the first record alone.
  const model = port((ids) =>
    ids.length > 1 || ids[0] === e0 ? "truncated" : "ok",
  );

  const first = await pass(f, model.producer, DEFAULT_EXTRACTION_CONFIG);
  expect(model.requests).toEqual([[e0, e1]]);
  expect(first).toMatchObject({ records_skipped: 0, stopped: null });
  expect(readExtractCursor(f.db)).toBeNull();

  // The narrowing survives the pass: a new process state asks for the first record alone.
  const second = await pass(f, model.producer, DEFAULT_EXTRACTION_CONFIG);
  expect(model.requests).toEqual([[e0, e1], [e0]]);
  expect(second).toMatchObject({ records_skipped: 1, stopped: null });
  expect(second.errors).toContain("record skipped: rejected on its own twice");
  expect(endsAt(readExtractCursor(f.db), e0)).toBe(true);

  const third = await pass(f, model.producer, DEFAULT_EXTRACTION_CONFIG);
  expect(model.requests).toEqual([[e0, e1], [e0], [e1]]);
  expect(third).toMatchObject({ records_skipped: 0, claims_extracted: 1 });
  expect(modelClaims(f.db)).toBe(1);
  expect(endsAt(readExtractCursor(f.db), e1)).toBe(true);
});

test("a model that rejects every request makes the default pass stop instead of skipping the ledger", async () => {
  const f = fixture(6);
  const model = port(() => "truncated");
  const skipped: number[] = [];
  const stops: (string | null)[] = [];
  let trippedAfter: number | undefined;
  let minute = 0;
  for (let index = 0; index < 7; index++) {
    minute += 15;
    const result = await pass(
      f,
      model.producer,
      DEFAULT_EXTRACTION_CONFIG,
      at(minute),
    );
    skipped.push(result.records_skipped);
    stops.push(result.stopped);
    if (result.stopped === "model:systemic_rejection") trippedAfter ??= model.requests.length;
  }
  // Three different records rejected the same way is the model, not the records.
  expect(stops).toContain("model:systemic_rejection");
  expect(skipped.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(2);
  // Two records were passed over and one narrowed before the third showed it: five requests.
  expect(trippedAfter).toBeLessThanOrEqual(6);
  expect(modelClaims(f.db)).toBe(0);
  const [head] = f.eventIds as [string];
  // Nothing was lost: a healthy model still gets every record, the ones passed over first.
  const healthy = port(() => "ok");
  minute += 24 * 60;
  for (let index = 0; index < 3; index++) {
    minute += 15;
    await pass(
      f,
      healthy.producer,
      limits({ max_calls_per_pass: 8, records_per_request: 1 }),
      at(minute),
    );
  }
  expect(modelClaims(f.db)).toBe(6);
  expect(healthy.requests.flat()).toContain(head);
});

test("systemic rejection at max_calls_per_pass 2 or more stops the pass with a typed reason, records nothing as skipped and backs off", async () => {
  const f = fixture(10);
  const [e0, e1, e2] = f.eventIds as [string, string, string];
  const settings = limits({ max_calls_per_pass: 8 });
  const model = port(() => "truncated");

  const first = await pass(f, model.producer, settings, at(0));
  expect(first.stopped).toBe("model:systemic_rejection");
  expect(first.records_skipped).toBe(0);
  expect(first.model.calls).toBe(model.requests.length);
  expect(model.requests.length).toBeLessThanOrEqual(6);
  // Bounded: the cursor never got past a small number of records.
  const cursor = readExtractCursor(f.db);
  expect([e0, e1, e2].some((id) => endsAt(cursor, id)) || cursor === null).toBe(
    true,
  );
  expect(first.model.last_rejection_rule).toBe("response_truncated");
  expect(first.model.consecutive_rejections).toBeGreaterThanOrEqual(3);
  // Rejected requests are billed: their usage is counted.
  expect(first.model.input_tokens).toBe(100 * model.requests.length);
  expect(first.model.output_tokens).toBe(600 * model.requests.length);

  // Backed off: no request leaves until the persisted wait is over.
  const sent = model.requests.length;
  const waiting = await pass(f, model.producer, settings, at(5));
  expect(waiting.stopped).toBe("model:systemic_rejection");
  expect(waiting.model.calls).toBe(0);
  expect(model.requests.length).toBe(sent);
  expect(waiting.errors.join(" ")).toContain("backing off");

  // After the wait one probe goes out; it fails, nothing is skipped, and the wait doubles.
  const probe = await pass(f, model.producer, settings, at(20));
  expect(probe.model.calls).toBe(1);
  expect(probe.stopped).toBe("model:systemic_rejection");
  expect(probe.records_skipped).toBe(0);
  const beforeRetry = model.requests.length;
  await pass(f, model.producer, settings, at(20 + 20));
  expect(model.requests.length).toBe(beforeRetry);

  // Once the model answers, every record is extracted, including the ones passed over first.
  const healthy = port(() => "ok");
  for (let index = 0; index < 4; index++)
    await pass(f, healthy.producer, settings, at(24 * 60 + index * 10));
  expect(modelClaims(f.db)).toBe(10);
  const late = await pass(f, healthy.producer, settings, at(24 * 60 + 100));
  expect(late.model.calls).toBe(0);
});

test("a record a rejection was blamed on is not lost when the model turns out to be at fault", async () => {
  const f = fixture(6);
  const settings = limits({ max_calls_per_pass: 8, records_per_request: 1 });
  const model = port(() => "bad_response");
  const first = await pass(f, model.producer, settings, at(0));
  expect(first.stopped).toBe("model:systemic_rejection");
  const skippedInReceipts = first.records_skipped;
  expect(skippedInReceipts).toBe(0);
  const healthy = port(() => "ok");
  for (let index = 0; index < 3; index++)
    await pass(f, healthy.producer, settings, at(24 * 60 + index));
  expect(modelClaims(f.db)).toBe(6);
});

test("rejections of different kinds do not add up to a systemic failure", async () => {
  const f = fixture(6);
  const settings = limits({ max_calls_per_pass: 12, records_per_request: 1 });
  // Records fail on their own, in turn, in different ways; every other one is answered.
  const ids = f.eventIds as readonly string[];
  const model = port((request) => {
    const head = request[0]!;
    if (head === ids[1]) return "truncated";
    if (head === ids[3]) return "bad_response";
    return "ok";
  });
  const receipt = await pass(f, model.producer, settings, at(0));
  expect(receipt.stopped).toBeNull();
  expect(receipt.records_skipped).toBe(2);
  expect(modelClaims(f.db)).toBe(4);
});

test("a record answered after a rejection resets the streak and the wait", async () => {
  const f = fixture(6);
  const settings = limits({ max_calls_per_pass: 5, records_per_request: 1 });
  const ids = f.eventIds as readonly string[];
  const model = port((request) => (request[0] === ids[1] ? "truncated" : "ok"));
  const receipt = await pass(f, model.producer, settings, at(0));
  expect(receipt.stopped).toBeNull();
  expect(receipt.records_skipped).toBe(1);
  expect(receipt.model.consecutive_rejections).toBeUndefined();
});

test("a rejected response's usage is recorded in the receipt and in extract_usage", async () => {
  const f = fixture(3);
  writeServeToml(f.vault, "[extraction]\nmax_calls_per_pass = 1\n");
  const model = port(() => "truncated");
  const receipt = await runRail(f.db, f.vault, "sync", {
    hooks: { producer: model.producer, claims: { db: f.db }, model_ref: MODEL },
  });
  expect(receipt.model).toMatchObject({
    calls: 1,
    input_tokens: 100,
    output_tokens: 600,
    last_request: "failed",
  });
  expect(receipt.model.usage_unknown).toBeUndefined();
  const rows = f.db
    .query<{ metrics: string }, []>("SELECT metrics FROM extract_usage")
    .all();
  for (const row of rows)
    expect(JSON.parse(row.metrics).model).toMatchObject({
      input_tokens: 100,
      output_tokens: 600,
    });
});

test("a truncated chat completion that reports usage is billed through the shipped producer", async () => {
  const f = fixture(2);
  const scripted = scriptedModelProducer(f.vault, () => "truncated_billed");
  const receipt = await runRail(f.db, f.vault, "sync", {
    hooks: {
      producer: scripted.producer,
      claims: { db: f.db },
      model_ref: MODEL,
    },
  });
  expect(receipt.model).toMatchObject({
    calls: 1,
    input_tokens: 700,
    output_tokens: 8192,
  });
  expect(receipt.model.diagnostic).toEqual(TRUNCATED);
});

test("receipts carry the rejection streak and the last rule, and they survive the journal", async () => {
  const f = fixture(4);
  const settings = limits({ max_calls_per_pass: 1 });
  writeServeToml(f.vault, "[extraction]\nmax_calls_per_pass = 1\n");
  expect(settings.max_calls_per_pass).toBe(1);
  const model = port(() => "truncated");
  const first = await runRail(f.db, f.vault, "sync", {
    hooks: { producer: model.producer, claims: { db: f.db }, model_ref: MODEL },
  });
  expect(first.model).toMatchObject({
    consecutive_rejections: 1,
    last_rejection_rule: "response_truncated",
  });
  const second = await runRail(f.db, f.vault, "sync", {
    hooks: { producer: model.producer, claims: { db: f.db }, model_ref: MODEL },
  });
  expect(second.model).toMatchObject({
    consecutive_rejections: 2,
    last_rejection_rule: "response_truncated",
  });
  const [latest] = listRunReceipts(f.db, { rail: "sync", limit: 1 });
  expect(latest?.model).toMatchObject({
    consecutive_rejections: 2,
    last_rejection_rule: "response_truncated",
  });
  // A receipt from before the field exists reads as no streak.
  const ok = port(() => "ok");
  const healed = await runRail(f.db, f.vault, "sync", {
    hooks: { producer: ok.producer, claims: { db: f.db }, model_ref: MODEL },
  });
  expect(healed.model.consecutive_rejections).toBeUndefined();
  expect(healed.model.last_rejection_rule).toBeUndefined();
});

test("a pass that waits out a backoff still reports the streak in its receipt", async () => {
  const f = fixture(6);
  writeServeToml(f.vault, "[extraction]\nmax_calls_per_pass = 8\nrecords_per_request = 1\n");
  const model = port(() => "truncated");
  const hooks = { producer: model.producer, claims: { db: f.db }, model_ref: MODEL };
  const tripped = await runRail(f.db, f.vault, "sync", { hooks, now: () => at(0) });
  expect(tripped).toMatchObject({ status: "stopped", stopped: "model:systemic_rejection", records_skipped: 0 });
  const sent = model.requests.length;
  const waiting = await runRail(f.db, f.vault, "sync", { hooks, now: () => at(1) });
  expect(waiting).toMatchObject({ status: "stopped", stopped: "model:systemic_rejection", model: { calls: 0 } });
  expect(waiting.model.consecutive_rejections).toBe(tripped.model.consecutive_rejections);
  expect(waiting.model.last_rejection_rule).toBe("response_truncated");
  expect(model.requests.length).toBe(sent);
});

test("max_calls_per_day stops the pass as model:budget_day and resumes the next UTC day", async () => {
  const f = fixture(12);
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 5\nrecords_per_request = 1\nmax_calls_per_day = 3\n",
  );
  const settings = loadServeConfig(f.vault).extraction;
  expect(settings.max_calls_per_day).toBe(3);
  const model = port(() => "ok");

  const first = await pass(f, model.producer, settings, at(60));
  expect(first).toMatchObject({
    stopped: "model:budget_day",
    claims_extracted: 3,
    model: { calls: 3 },
  });
  const again = await pass(f, model.producer, settings, at(120));
  expect(again).toMatchObject({
    stopped: "model:budget_day",
    model: { calls: 0 },
  });
  expect(again.errors.join(" ")).toContain("max_calls_per_day");
  expect(model.requests.length).toBe(3);

  const tomorrow = await pass(f, model.producer, settings, at(24 * 60 + 60));
  expect(tomorrow).toMatchObject({
    stopped: "model:budget_day",
    claims_extracted: 3,
    model: { calls: 3 },
  });
  expect(model.requests.length).toBe(6);
});

test("max_output_tokens_per_day counts rejected responses and stops the pass as model:budget_day", async () => {
  const f = fixture(6);
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 8\nrecords_per_request = 1\nmax_output_tokens_per_day = 1024\n",
  );
  const settings = loadServeConfig(f.vault).extraction;
  expect(settings.max_output_tokens_per_day).toBe(1024);
  // Each rejected request bills 600 output tokens: the second call crosses the day's cap.
  const model = port((ids) =>
    ids[0] === (f.eventIds as readonly string[])[0] ? "truncated" : "ok",
  );
  const receipt = await pass(f, model.producer, settings, at(10));
  expect(receipt.stopped).toBe("model:budget_day");
  expect(receipt.model.calls).toBe(2);
  expect(receipt.model.output_tokens).toBe(600 + 600);
  const blocked = await pass(f, model.producer, settings, at(20));
  expect(blocked).toMatchObject({
    stopped: "model:budget_day",
    model: { calls: 0 },
  });
});

test("daily budgets parse within bounds and have a default that bounds spend", () => {
  const f = fixture(0);
  expect(DEFAULT_EXTRACTION_CONFIG.max_calls_per_day).toBeGreaterThan(0);
  expect(DEFAULT_EXTRACTION_CONFIG.max_output_tokens_per_day).toBeGreaterThan(
    0,
  );
  expect(loadServeConfig(f.vault).extraction).toMatchObject({
    max_calls_per_day: DEFAULT_EXTRACTION_CONFIG.max_calls_per_day,
    max_output_tokens_per_day:
      DEFAULT_EXTRACTION_CONFIG.max_output_tokens_per_day,
  });
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_day = 40\nmax_output_tokens_per_day = 50000\n",
  );
  expect(loadServeConfig(f.vault).extraction).toMatchObject({
    max_calls_per_day: 40,
    max_output_tokens_per_day: 50_000,
  });
  writeServeToml(
    f.vault,
    '[extraction]\nmax_calls_per_day = 0\nmax_output_tokens_per_day = "9"\n',
  );
  expect(loadServeConfig(f.vault).extraction).toMatchObject({
    max_calls_per_day: DEFAULT_EXTRACTION_CONFIG.max_calls_per_day,
    max_output_tokens_per_day:
      DEFAULT_EXTRACTION_CONFIG.max_output_tokens_per_day,
  });
  expect(new PortError("unavailable", "x", false).usage).toBeUndefined();
});

test("the refusal history narrows, skips on the second refusal alone, and trips on the third record", () => {
  const refuse = (prior: ReturnType<typeof readRejections>, head: string, single: boolean, rule = "response_truncated") =>
    recordRejection(prior, { head, rule, single }, at(0));
  const one = refuse(null, "A", false);
  expect(one.action).toEqual({ kind: "narrow" });
  expect(one.state).toMatchObject({ consecutive: 1, narrow: "A", heads: ["A"], passed_over: [] });
  const two = refuse(one.state, "A", true);
  expect(two.action).toEqual({ kind: "skip" });
  expect(two.state).toMatchObject({ consecutive: 2, narrow: null, passed_over: ["A"] });
  const three = refuse(two.state, "B", false);
  expect(three.action).toEqual({ kind: "narrow" });
  const four = refuse(three.state, "B", true);
  expect(four.state.passed_over).toEqual(["A", "B"]);
  const trip = refuse(four.state, "C", false);
  expect(trip.action).toEqual({ kind: "trip", requeue: ["A", "B"] });
  expect(trip.state).toMatchObject({ narrow: null, passed_over: [], trips: 1, backoff_until: at(15) });
  // A probe that fails again trips again with a longer wait and lists nothing new.
  const probe = recordRejection(trip.state, { head: "A", rule: "response_truncated", single: false }, at(15));
  expect(probe.action).toEqual({ kind: "trip", requeue: [] });
  expect(probe.state).toMatchObject({ trips: 2, backoff_until: at(15 + 30) });
  // A different rule is a different failure: the count starts again.
  const other = refuse(two.state, "B", false, "bad_response");
  expect(other.state).toMatchObject({ consecutive: 1, rule: "bad_response", passed_over: [], heads: ["B"] });
  expect([1, 2, 3, 4, 5, 6, 7].map(rejectionBackoffMs)).toEqual([15, 30, 60, 120, 240, 360, 360].map((minutes) => minutes * 60_000));
  expect(backoffRemaining(trip.state, at(14))).toBe(at(15));
  expect(backoffRemaining(trip.state, at(15))).toBeNull();
  expect(backoffRemaining(null, at(0))).toBeNull();
});

test("the refusal history round-trips, clears, and reads unreadable rows as no history", () => {
  const f = fixture(0);
  expect(readRejections(f.db)).toBeNull();
  const { state } = recordRejection(null, { head: "A", rule: "response_truncated", single: false }, at(0));
  writeRejections(f.db, state);
  expect(readRejections(f.db)).toEqual(state);
  writeRejections(f.db, null);
  expect(readRejections(f.db)).toBeNull();
  for (const bad of ["not json", "[]", '{"consecutive":0}', JSON.stringify({ ...state, heads: "A" }), JSON.stringify({ ...state, backoff_until: "soon" })]) {
    f.db.query("INSERT OR REPLACE INTO rail_cursors(rail,source_key,cursor,updated_at) VALUES ('kizuki.producer.model','extract-rejections',?,?)").run(bad, at(0));
    expect(readRejections(f.db)).toBeNull();
  }
});

test("requeuing passed-over records needs a transaction and leaves out records that are gone", () => {
  const f = fixture(2);
  const [e0] = f.eventIds as [string, string];
  expect(() => requeuePassedOverRecords(f.db, [e0])).toThrow("requires a transaction");
  const queued = f.db.transaction(() => requeuePassedOverRecords(f.db, [e0, "01J0000000000000000000GONE"])).immediate();
  expect(queued).toBe(1);
  expect(f.db.query<{ event_id: string }, []>("SELECT event_id FROM extract_deferred_inputs").all()).toEqual([{ event_id: e0 }]);
});
