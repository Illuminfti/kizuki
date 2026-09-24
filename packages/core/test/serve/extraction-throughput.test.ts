import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { listClaims } from "../../src/claims/store";
import { registerConnection } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { planModelExtractionV2 } from "../../src/producer/model-v2";
import { EXTRACT_MAX_OUTPUT_TOKENS } from "../../src/producer/model";
import { loadServeConfig } from "../../src/serve/config";
import { runServeDaemon } from "../../src/serve/daemon";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { readExtractCursor } from "../../src/serve/extract";
import { worldProduceInput } from "../../src/serve/extract-v2";
import { runRail } from "../../src/serve/rails";
import { writeServeIntent } from "../../src/serve/intent";
import { listRunReceipts, persistRunReceipt } from "../../src/serve/receipts";
import { initServe, listSchedules } from "../../src/serve/schema";
import { requestServeStop } from "../../src/serve/stop-control";
import type { SupervisorHost } from "../../src/serve/supervisor";
import {
  DEFAULT_EXTRACTION_CONFIG,
  DEFAULT_RAILS,
  DEFAULT_SERVE_CONFIG,
  emptyRunTotals,
  type ExtractionConfig,
} from "../../src/serve/types";
import { runWritePass } from "../../src/serve/write-pass";
import { withVaultMutationSync } from "../../src/vault/mutation-scope";
import {
  MODEL,
  fixtureProducer,
  recordText,
  scriptedModelProducer,
  throughputVault,
  writeServeToml,
  type ThroughputVault,
} from "./throughput-fixture";
import { validEvent } from "../fixtures";

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
const endsAt = (cursor: string | null, eventId: string): boolean =>
  cursor?.endsWith(`\t${eventId}`) === true;
const modelClaims = (db: Database): number =>
  listClaims(db, { status: "live", limit: 1_000 }).filter(
    (claim) => claim.producer === "model",
  ).length;

/** Extraction only: without a model reference the pass files claims but writes no canon. */
function extractionPass(
  f: { db: Database; vault: string },
  producer: ReturnType<typeof fixtureProducer>["producer"],
  extraction?: ExtractionConfig,
) {
  return runWritePass(f.db, f.vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 0 }),
    producer,
    claims: { db: f.db },
    ...(extraction === undefined ? {} : { extraction }),
  });
}

test("serve.toml throughput settings parse within bounds and keep today's defaults", () => {
  const f = fixture(0);
  const defaults = {
    sync_period_s: 900,
    extraction: {
      max_calls_per_pass: 1,
      records_per_request: 2,
      max_input_tokens: 8_000,
      max_output_tokens: EXTRACT_MAX_OUTPUT_TOKENS,
      max_pass_seconds: 60,
    },
  };
  expect(loadServeConfig(f.vault)).toMatchObject(defaults);
  expect(DEFAULT_RAILS.find((spec) => spec.rail === "sync")?.period_s).toBe(
    DEFAULT_SERVE_CONFIG.sync_period_s,
  );

  writeServeToml(
    f.vault,
    "[serve]\nsync_period_s = 60\n[extraction]\nmax_calls_per_pass = 256\nrecords_per_request = 8\nmax_input_tokens = 32000\nmax_output_tokens = 16384\nmax_pass_seconds = 600\n",
  );
  expect(loadServeConfig(f.vault)).toMatchObject({
    sync_period_s: 60,
    extraction: {
      max_calls_per_pass: 256,
      records_per_request: 8,
      max_input_tokens: 32_000,
      max_output_tokens: 16_384,
      max_pass_seconds: 600,
    },
  });

  // Out of range, fractional, or mistyped values keep their defaults one by one.
  writeServeToml(
    f.vault,
    '[serve]\nsync_period_s = 59\n[extraction]\nmax_calls_per_pass = 257\nrecords_per_request = 0\nmax_input_tokens = 8000.5\nmax_output_tokens = "16384"\nmax_pass_seconds = 29\n',
  );
  expect(loadServeConfig(f.vault)).toMatchObject(defaults);
  writeServeToml(
    f.vault,
    "[serve]\nsync_period_s = 86401\n[extraction]\nmax_calls_per_pass = 24\nmax_input_tokens = 1999\nmax_output_tokens = 16385\nmax_pass_seconds = 601\n",
  );
  expect(loadServeConfig(f.vault)).toMatchObject({
    ...defaults,
    extraction: { ...defaults.extraction, max_calls_per_pass: 24 },
  });
});

test("a pass makes up to max_calls_per_pass requests and commits each one before the next leaves", async () => {
  const f = fixture(5);
  const [e0, e1, e2, e3, e4] = f.eventIds as [
    string,
    string,
    string,
    string,
    string,
  ];
  const { producer, calls } = fixtureProducer(() => f.db);
  const settings = limits({ max_calls_per_pass: 3, records_per_request: 1 });

  const first = await extractionPass(f, producer, settings);
  expect(first).toMatchObject({
    stopped: null,
    errors: [],
    claims_extracted: 3,
    model: { calls: 3 },
  });
  expect(calls.map((call) => call.event_ids)).toEqual([[e0], [e1], [e2]]);
  // Each request leaves only after the previous decision is filed and its cursor committed.
  expect(
    calls.map((call) =>
      call.cursor === null ? null : call.cursor.split("\t")[1],
    ),
  ).toEqual([null, e0, e1]);
  expect(endsAt(readExtractCursor(f.db), e2)).toBe(true);
  expect(modelClaims(f.db)).toBe(3);
  expect(f.db.query("SELECT 1 FROM extract_batches").all()).toEqual([]);

  // The next pass resumes at the cursor and stops early once the ledger is drained.
  const second = await extractionPass(f, producer, settings);
  expect(second).toMatchObject({
    stopped: null,
    errors: [],
    claims_extracted: 2,
    model: { calls: 2 },
  });
  expect(calls.slice(3).map((call) => call.event_ids)).toEqual([[e3], [e4]]);
  expect(endsAt(readExtractCursor(f.db), e4)).toBe(true);
  expect((await extractionPass(f, producer, settings)).model.calls).toBe(0);
  expect(modelClaims(f.db)).toBe(5);
});

test("without settings a pass keeps one two-record request with today's reservations", async () => {
  const f = fixture(5);
  const { producer, calls } = fixtureProducer(() => f.db);
  const result = await extractionPass(f, producer);
  expect(result.model.calls).toBe(1);
  expect(calls).toEqual([
    {
      event_ids: f.eventIds.slice(0, 2),
      cursor: null,
      budget: {
        max_calls: 1,
        max_input_tokens: 8_000,
        max_output_tokens: EXTRACT_MAX_OUTPUT_TOKENS,
      },
    },
  ]);
});

test("records_per_request and token reservations reach the typed request and its planner", async () => {
  const f = fixture(6);
  const { producer, calls } = fixtureProducer(() => f.db);
  await extractionPass(
    f,
    producer,
    limits({
      records_per_request: 4,
      max_input_tokens: 12_000,
      max_output_tokens: 16_384,
    }),
  );
  expect(calls).toEqual([
    {
      event_ids: f.eventIds.slice(0, 4),
      cursor: null,
      budget: {
        max_calls: 1,
        max_input_tokens: 12_000,
        max_output_tokens: 16_384,
      },
    },
  ]);
  const input = worldProduceInput(
    f.eventIds
      .slice(0, 4)
      .map(
        (event_id, index) => ({ event_id, text: recordText(index) }) as never,
      ),
    [],
    { max_input_tokens: 12_000, max_output_tokens: 16_384 },
  );
  const plan = planModelExtractionV2(input);
  expect(plan.status === "ready" ? plan.max_output_tokens : null).toBe(16_384);
});

test("a rate-limited provider ends the pass as a typed stop and the next pass resumes from the durable cursor", async () => {
  const f = fixture(4);
  const [e0, e1, e2, e3] = f.eventIds as [string, string, string, string];
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 4\nrecords_per_request = 1\n",
  );
  const limited = scriptedModelProducer(f.vault, (request) =>
    request === 3 ? "rate_limited" : "ok",
  );
  const stopped = await runRail(f.db, f.vault, "sync", {
    hooks: {
      producer: limited.producer,
      claims: { db: f.db },
      model_ref: MODEL,
    },
  });
  expect(stopped).toMatchObject({
    status: "stopped",
    stopped: "model:rate_limited",
    claims_extracted: 2,
    model: {
      calls: 3,
      unavailable: 1,
      diagnostic: { stage: "transport", rule: "http", http_status: 429 },
    },
  });
  expect(stopped.errors).toEqual(["model transport: http status=429"]);
  expect(limited.requests).toEqual([[e0], [e1], [e2]]);
  // Work filed before the refusal stays filed; the refused record stays pending.
  expect(endsAt(readExtractCursor(f.db), e1)).toBe(true);
  expect(modelClaims(f.db)).toBe(2);

  const recovered = scriptedModelProducer(f.vault, () => "ok");
  const resumed = await runRail(f.db, f.vault, "sync", {
    hooks: {
      producer: recovered.producer,
      claims: { db: f.db },
      model_ref: MODEL,
    },
  });
  expect(resumed).toMatchObject({
    stopped: null,
    claims_extracted: 2,
    model: { calls: 2, unavailable: 0 },
  });
  expect(recovered.requests).toEqual([[e2], [e3]]);
  expect(endsAt(readExtractCursor(f.db), e3)).toBe(true);
  expect(modelClaims(f.db)).toBe(4);
});

test("a rejected response is asked again once; a record rejected on its own twice is skipped with its reason", async () => {
  const f = fixture(3);
  const [e0, e1, e2] = f.eventIds as [string, string, string];
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 5\nrecords_per_request = 1\n",
  );
  const flaky = scriptedModelProducer(f.vault, (request) =>
    request === 2 ? "malformed" : "ok",
  );
  const recovered = await runRail(f.db, f.vault, "sync", {
    hooks: { producer: flaky.producer, claims: { db: f.db }, model_ref: MODEL },
  });
  expect(flaky.requests).toEqual([[e0], [e1], [e1], [e2]]);
  expect(recovered).toMatchObject({
    status: "degraded",
    stopped: null,
    claims_extracted: 3,
    records_skipped: 0,
    model: { calls: 4 },
  });
  expect(recovered.errors).toContain("model response rejected: bad response");
  expect(endsAt(readExtractCursor(f.db), e2)).toBe(true);

  const g = fixture(3);
  const [g0, g1, g2] = g.eventIds as [string, string, string];
  writeServeToml(
    g.vault,
    "[extraction]\nmax_calls_per_pass = 5\nrecords_per_request = 1\n",
  );
  const stuck = scriptedModelProducer(g.vault, (_request, ids) =>
    ids.includes(g0) ? "malformed" : "ok",
  );
  const passed = await runRail(g.db, g.vault, "sync", {
    hooks: { producer: stuck.producer, claims: { db: g.db }, model_ref: MODEL },
  });
  // One retry per record; a record that fails on its own again cannot hold the backlog.
  expect(stuck.requests).toEqual([[g0], [g0], [g1], [g2]]);
  expect(passed).toMatchObject({
    status: "degraded",
    stopped: null,
    claims_extracted: 2,
    records_skipped: 1,
    model: { calls: 4 },
  });
  expect(passed.errors).toContain("record skipped: rejected on its own twice");
  expect(endsAt(readExtractCursor(g.db), g2)).toBe(true);
  expect(modelClaims(g.db)).toBe(2);
  expect(
    listClaims(g.db, { limit: 100 }).some((claim) =>
      claim.provenance.includes(g0),
    ),
  ).toBe(false);
});

test("a truncated multi-record response is asked again for its first record alone", async () => {
  const f = fixture(4);
  const [e0, e1, e2, e3] = f.eventIds as [string, string, string, string];
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 6\nrecords_per_request = 2\n",
  );
  const model = scriptedModelProducer(f.vault, (request) =>
    request === 1 ? "truncated" : "ok",
  );
  const receipt = await runRail(f.db, f.vault, "sync", {
    hooks: { producer: model.producer, claims: { db: f.db }, model_ref: MODEL },
  });
  expect(model.requests).toEqual([[e0, e1], [e0], [e1, e2], [e3]]);
  expect(receipt).toMatchObject({
    stopped: null,
    claims_extracted: 4,
    records_skipped: 0,
    model: { calls: 4 },
  });
  expect(receipt.errors).toContain(
    "model response rejected: response truncated",
  );
  expect(endsAt(readExtractCursor(f.db), e3)).toBe(true);
});

test("a single token too large for any request is skipped with a receipt instead of holding the cursor", async () => {
  const oversized = "x".repeat(24_001);
  const g = throughputVault(3, (index) =>
    index === 1 ? oversized : recordText(index),
  );
  const db = openLedger(g.ledger);
  disposers.push(g.dispose, () => db.close());
  const [e0, e1, e2] = g.eventIds as [string, string, string];
  writeServeToml(g.vault, "[extraction]\nmax_calls_per_pass = 5\nrecords_per_request = 2\n");
  const model = scriptedModelProducer(g.vault, () => "ok");
  const receipt = await runRail(db, g.vault, "sync", { hooks: { producer: model.producer, claims: { db }, model_ref: MODEL } });
  // No request ever carries the unsplittable record, and it no longer holds the cursor.
  expect(model.requests).toEqual([[e0], [e2]]);
  expect(model.requests.flat()).not.toContain(e1);
  expect(receipt).toMatchObject({ status: "ok", stopped: null, errors: [], claims_extracted: 2, records_skipped: 0,
    model: { calls: 2 }, oversized: { segments: 0, skipped: 1 } });
  expect(endsAt(readExtractCursor(db), e2)).toBe(true);
  // The skip is the loop's receipted decision with a retry verb, not a throughput skip.
  const doctor = inspectServeDoctor(db, g.vault, { model_ref: MODEL });
  expect(doctor.throughput).toMatchObject({ records_skipped: 0 });
  expect(doctor.oversized).toMatchObject({ segmenting: 0, skipped: 1, retry: "kizuki serve retry-skipped" });
});

test("a typed request around a record its grant holds back journals only the records it sent", async () => {
  const f = fixture(1);
  const [e0] = f.eventIds as [string];
  const held = "01J00000000000000000000HVD";
  registerConnection(f.db, "kizuki.fixture", held);
  setSourceGrant(f.db, { source_key: held, expected_revision: 0, operation_id: "held-fixture-grant", policy: {
    purposes: ["capture", "recall", "derive", "extract"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public" } });
  const capture = (sourceKey: string, id: string, text: string): string => {
    const accepted = accept(f.db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: id, text, subjects: [] },
      { source: { source_key: sourceKey, expected_revision: 1 } });
    if (accepted.status !== "stored") throw new Error("fixture capture failed");
    return accepted.event.event_id;
  };
  const h1 = capture(held, "held-1", "A held synthetic record.");
  const e2 = capture("01J00000000000000000000SRC", "throughput-2", recordText(2));
  writeServeToml(f.vault, "[extraction]\nrecords_per_request = 4\n");
  const model = scriptedModelProducer(f.vault, () => "ok");
  const receipt = await runRail(f.db, f.vault, "sync", { hooks: { producer: model.producer, claims: { db: f.db }, model_ref: MODEL } });
  expect(model.requests).toEqual([[e0, e2]]);
  expect(receipt).toMatchObject({ status: "ok", errors: [], claims_extracted: 2, model: { calls: 1 } });
  expect(endsAt(readExtractCursor(f.db), e2)).toBe(true);
  expect(f.db.query("SELECT event_id FROM extract_deferred_inputs").all()).toEqual([{ event_id: h1 }]);
  expect(modelClaims(f.db)).toBe(2);
});

test("a rejection a later request answered past leaves doctor healthy and advances last success", async () => {
  const f = fixture(6);
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 8\nrecords_per_request = 1\n",
  );
  const flaky = scriptedModelProducer(f.vault, (request) =>
    request === 1 ? "malformed" : "ok",
  );
  const receipt = await runRail(f.db, f.vault, "sync", {
    hooks: { producer: flaky.producer, claims: { db: f.db }, model_ref: MODEL },
  });
  expect(receipt).toMatchObject({
    status: "degraded",
    claims_extracted: 6,
    model: { calls: 7, answered: 6, last_request: "answered" },
  });
  // The rejected request stays counted in the receipt; it is not how the pass ended.
  expect(receipt.model.diagnostic).toBeUndefined();
  expect(receipt.claims_rejected).toEqual({ schema_invalid: 1 });
  const doctor = inspectServeDoctor(f.db, f.vault, { model_ref: MODEL });
  expect(doctor.model).toMatchObject({
    current_failure: null,
    last_failure: null,
    last_success_at: receipt.finished_at,
  });
  expect(
    doctor.failures.filter((failure) => failure.includes("model")),
  ).toEqual([]);
});

test("a pass that ends rate-limited after answered requests still records its last success", async () => {
  const f = fixture(6);
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 8\nrecords_per_request = 1\n",
  );
  const limited = scriptedModelProducer(f.vault, (request) =>
    request === 4 ? "rate_limited" : "ok",
  );
  const receipt = await runRail(f.db, f.vault, "sync", {
    hooks: {
      producer: limited.producer,
      claims: { db: f.db },
      model_ref: MODEL,
    },
  });
  expect(receipt).toMatchObject({
    status: "stopped",
    stopped: "model:rate_limited",
    claims_extracted: 3,
    model: {
      calls: 4,
      answered: 3,
      last_request: "failed",
      diagnostic: { stage: "transport", rule: "http", http_status: 429 },
    },
  });
  const doctor = inspectServeDoctor(f.db, f.vault, { model_ref: MODEL });
  expect(doctor.model.last_success_at).toBe(receipt.finished_at);
  // The pass ended on the provider's refusal, so that stays the current failure until a request is answered.
  expect(doctor.model.current_failure).toEqual({
    at: receipt.finished_at,
    detail: "model transport: http status=429",
  });
});

test("a stop request ends the pass at the next step boundary", async () => {
  const f = fixture(5);
  const [, e1] = f.eventIds as [string, string];
  const { producer, calls } = fixtureProducer(() => f.db);
  const result = await runWritePass(f.db, f.vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 0 }),
    producer,
    claims: { db: f.db },
    extraction: limits({ max_calls_per_pass: 5, records_per_request: 1 }),
    stopRequested: () => calls.length >= 2,
  });
  expect(calls).toHaveLength(2);
  expect(result).toMatchObject({
    stopped: "serve:stop_requested",
    claims_extracted: 2,
    model: { calls: 2 },
  });
  expect(endsAt(readExtractCursor(f.db), e1)).toBe(true);
});

test("SIGTERM during a request lets it finish and ends the pass before the next one", () => {
  const f = fixture(20);
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 20\nrecords_per_request = 1\n",
  );
  const src = join(import.meta.dir, "../../src"),
    here = import.meta.dir;
  const child = spawnSync(
    process.execPath,
    [
      "--eval",
      `
    import { openLedger } from ${JSON.stringify(join(src, "ledger/db.ts"))};
    import { runServeDaemon } from ${JSON.stringify(join(src, "serve/daemon.ts"))};
    import { listRunReceipts } from ${JSON.stringify(join(src, "serve/receipts.ts"))};
    import { MODEL, fixtureProducer } from ${JSON.stringify(join(here, "throughput-fixture.ts"))};
    const db = openLedger(${JSON.stringify(f.ledger)});
    // The signal arrives while the second request is in flight.
    const { producer, calls } = fixtureProducer(() => db, async (_call, index) => {
      if (index === 2) { process.kill(process.pid, "SIGTERM"); await Bun.sleep(50); }
    });
    await runServeDaemon(db, ${JSON.stringify(f.vault)}, { once: true, http: false, rails: ["sync"], hooks: { producer, claims: { db }, model_ref: MODEL } });
    const receipt = listRunReceipts(db).find(item => item.rail === "sync");
    console.log(JSON.stringify({ calls: calls.length, status: receipt.status, stopped: receipt.stopped, claims: receipt.claims_extracted }));
  `,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect({ status: child.status, stderr: child.stderr }).toEqual({
    status: 0,
    stderr: "",
  });
  expect(JSON.parse(child.stdout)).toEqual({
    calls: 2,
    status: "stopped",
    stopped: "serve:stop_requested",
    claims: 2,
  });
}, 90_000);

test("the writer is free while a request is in flight, so a serve stop queued then ends the pass", async () => {
  const f = fixture(6);
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 6\nrecords_per_request = 1\n",
  );
  const owner: string[] = [];
  const { producer, calls } = fixtureProducer(
    () => f.db,
    async (_call, index) => {
      // Another writer, such as an owner correction or purge, gets the writer mid-request.
      owner.push(
        withVaultMutationSync({ vault_path: f.vault, db: f.db }, () => "held"),
      );
      if (index === 2) owner.push((await requestServeStop(f.vault)).status);
    },
  );
  await runServeDaemon(f.db, f.vault, {
    once: true,
    http: false,
    rails: ["sync"],
    hooks: { producer, claims: { db: f.db }, model_ref: MODEL },
  });
  expect(owner).toEqual(["held", "held", "queued"]);
  expect(calls).toHaveLength(2);
  const [sync] = listRunReceipts(f.db).filter((item) => item.rail === "sync");
  expect(sync).toMatchObject({
    status: "stopped",
    stopped: "serve:stop_requested",
    claims_extracted: 2,
  });
});

test("a pass starts no request once max_pass_seconds is spent", async () => {
  const f = fixture(10);
  let clock = Date.parse("2026-09-24T12:00:00.000Z");
  // Each request takes twenty seconds of the pass's clock.
  const { producer, calls } = fixtureProducer(
    () => f.db,
    () => {
      clock += 20_000;
    },
  );
  const result = await runWritePass(f.db, f.vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 0 }),
    producer,
    claims: { db: f.db },
    extraction: limits({
      max_calls_per_pass: 10,
      records_per_request: 1,
      max_pass_seconds: 60,
    }),
    now: () => new Date(clock).toISOString(),
  });
  expect(calls).toHaveLength(3);
  expect(result).toMatchObject({ stopped: null, claims_extracted: 3 });
});

test("a rail waiting behind a long extraction pass is not reported stale within the pass's time", () => {
  const f = fixture(0);
  writeServeIntent(f.vault, "installed");
  const supervisor: SupervisorHost = {
    kind: "systemd",
    home: "/tmp",
    execStart: "kizuki serve",
    query: () => ({
      kind: "systemd",
      state: "active",
      enabled: true,
      unit: "synthetic",
      detail: "active",
    }),
    reload: () => ({ ok: true, detail: "ok" }),
    enable: () => ({ ok: true, detail: "ok" }),
    disable: () => ({ ok: true, detail: "ok" }),
  };
  const finished = "2026-09-24T12:00:00.000Z";
  DEFAULT_RAILS.forEach((spec, index) =>
    persistRunReceipt(f.db, f.vault, {
      ...emptyRunTotals(),
      run_id: `01JRAILWAIT00000000000000${index}`,
      rail: spec.rail,
      started_at: finished,
      finished_at: finished,
      status: "ok",
      stopped: null,
      canon_writes: 1,
    }),
  );
  const embed = (now: string) =>
    inspectServeDoctor(f.db, f.vault, { now, supervisor }).rails.find(
      (rail) => rail.rail === "embed-backfill",
    )!;
  // One-request passes keep today's bound: three periods.
  expect(embed("2026-09-24T12:06:40.000Z")).toMatchObject({
    status: "down",
    reason: "stale 400s (period 60s)",
  });
  // A multi-request pass can keep the other rails waiting for its time budget.
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 24\nmax_pass_seconds = 300\n",
  );
  expect(embed("2026-09-24T12:06:40.000Z")).toMatchObject({
    status: "ok",
    reason: null,
  });
  expect(embed("2026-09-24T12:08:01.000Z")).toMatchObject({
    status: "down",
    reason: "stale 481s (period 60s)",
  });
});
test("a kill during a request loses only that request and the next pass resumes after the last filed one", () => {
  const f = fixture(5);
  const [e0, e1, e2] = f.eventIds as [string, string, string];
  writeServeToml(
    f.vault,
    "[extraction]\nmax_calls_per_pass = 5\nrecords_per_request = 1\n",
  );
  const src = join(import.meta.dir, "../../src"),
    here = import.meta.dir;
  const child = spawnSync(
    process.execPath,
    [
      "--eval",
      `
    import { openLedger } from ${JSON.stringify(join(src, "ledger/db.ts"))};
    import { runRail } from ${JSON.stringify(join(src, "serve/rails.ts"))};
    import { MODEL, fixtureProducer } from ${JSON.stringify(join(here, "throughput-fixture.ts"))};
    const db = openLedger(${JSON.stringify(f.ledger)});
    const { producer } = fixtureProducer(() => db, (_call, index) => { if (index === 3) process.kill(process.pid, "SIGKILL"); });
    await runRail(db, ${JSON.stringify(f.vault)}, "sync", { hooks: { producer, claims: { db }, model_ref: MODEL } });
    process.exit(74);
  `,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect({ signal: child.signal, stderr: child.stderr }).toEqual({
    signal: "SIGKILL",
    stderr: "",
  });

  const db = openLedger(f.ledger);
  disposers.push(() => db.close());
  // Two requests were filed and committed; the third was in flight.
  expect(endsAt(readExtractCursor(db), e1)).toBe(true);
  expect(modelClaims(db)).toBe(2);
  expect(db.query("SELECT 1 FROM extract_batches").all()).toEqual([]);
  const usage = db
    .query<{ metrics: string }, []>("SELECT metrics FROM extract_usage")
    .get();
  expect(JSON.parse(usage!.metrics)).toMatchObject({
    claims_extracted: 2,
    model: { calls: 3, usage_unknown: true },
  });

  return (async () => {
    const { producer, calls } = fixtureProducer(() => db);
    const next = await runRail(db, f.vault, "sync", {
      hooks: { producer, claims: { db }, model_ref: MODEL },
    });
    expect(calls[0]!.event_ids).toEqual([e2]);
    expect(calls.flatMap((call) => call.event_ids)).not.toContain(e0);
    expect(next).toMatchObject({
      stopped: null,
      claims_extracted: 3,
      model: { calls: 3 },
    });
    expect(modelClaims(db)).toBe(5);
    const killed = listRunReceipts(db).filter(
      (receipt) => receipt.run_id !== next.run_id && receipt.rail === "sync",
    );
    expect(
      killed.map((receipt) => [
        receipt.status,
        receipt.model.calls,
        receipt.errors,
      ]),
    ).toEqual([
      ["failed", 3, ["model attempt interrupted; token usage unknown"]],
    ]);
  })();
}, 90_000);

test("64-request passes keep statements finalized and memory flat", async () => {
  const PASS = 64, PASSES = 4;
  const vault = throughputVault(PASS * PASSES);
  disposers.push(vault.dispose);
  // Track every statement this connection prepares, finalized or not.
  const prepared: { readonly isFinalized: boolean }[] = [];
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function (this: Database, ...args: Parameters<Database["prepare"]>) {
    const statement = Reflect.apply(original, this, args) as ReturnType<Database["prepare"]>;
    prepared.push(statement as unknown as { readonly isFinalized: boolean });
    return statement;
  } as Database["prepare"];
  let db: Database;
  try { db = openLedger(vault.ledger); } finally { Database.prototype.prepare = original; }
  disposers.push(() => db.close());
  const f = { db, vault: vault.vault };
  const { producer, calls } = fixtureProducer(() => db);
  const passes: { live: number; heap: number; rss: number }[] = [];
  for (let pass = 0; pass < PASSES; pass++) {
    const from = prepared.length;
    const result = await extractionPass(f, producer, limits({ max_calls_per_pass: PASS, records_per_request: 1 }));
    expect(result).toMatchObject({ stopped: null, errors: [], claims_extracted: PASS, model: { calls: PASS } });
    Bun.gc(true);
    const memory = process.memoryUsage();
    passes.push({ live: prepared.slice(from).filter(statement => !statement.isFinalized).length, heap: memory.heapUsed, rss: memory.rss });
  }
  prepared.length = 0;
  expect(calls).toHaveLength(PASS * PASSES);
  expect(modelClaims(db)).toBe(PASS * PASSES);
  // After the first pass warms the statement cache, a pass leaves no statement
  // unfinalized, and three more full passes grow neither heap nor native memory.
  expect(passes.slice(1).map(pass => pass.live)).toEqual([0, 0, 0]);
  expect(passes[3]!.heap - passes[1]!.heap).toBeLessThan(4 * 1024 * 1024);
  expect(passes[3]!.rss - passes[1]!.rss).toBeLessThan(32 * 1024 * 1024);
}, 180_000);

test("a service start applies the configured sync period; doctor shows effective and configured throughput", async () => {
  const f = fixture(0);
  initServe(f.db);
  const now = "2026-09-24T12:00:00.000Z";
  f.db
    .query("UPDATE schedules SET next_run_at=? WHERE rail='sync'")
    .run("2026-09-24T12:14:00.000Z");
  writeServeToml(
    f.vault,
    "[serve]\nsync_period_s = 120\n[extraction]\nmax_calls_per_pass = 24\n",
  );
  const before = inspectServeDoctor(f.db, f.vault, { now });
  expect(before.throughput).toEqual({
    sync_period_s: 900,
    configured_sync_period_s: 120,
    max_calls_per_pass: 24,
    records_per_request: 2,
    max_input_tokens: 8_000,
    max_output_tokens: 8_192,
    max_pass_seconds: 60,
    records_skipped: 0,
    detail:
      "throughput sync_period_s=900 max_calls_per_pass=24 records_per_request=2 max_input_tokens=8000 max_output_tokens=8192 max_pass_seconds=60 records_skipped=0 configured_sync_period_s=120 (applies at service start)",
  });

  await runServeDaemon(f.db, f.vault, {
    once: true,
    http: false,
    rails: ["journal-prune"],
    now: () => now,
  });
  const sync = listSchedules(f.db).find((row) => row.rail === "sync")!;
  // A shorter period brings a later due slot in to one new period from now.
  expect([sync.period_s, sync.next_run_at]).toEqual([
    120,
    "2026-09-24T12:02:00.000Z",
  ]);
  const after = inspectServeDoctor(f.db, f.vault, { now });
  expect(after.throughput).toMatchObject({
    sync_period_s: 120,
    configured_sync_period_s: 120,
  });
  expect(after.throughput.detail).toBe(
    "throughput sync_period_s=120 max_calls_per_pass=24 records_per_request=2 max_input_tokens=8000 max_output_tokens=8192 max_pass_seconds=60 records_skipped=0",
  );
  expect(after.rails.find((rail) => rail.rail === "sync")?.period_s).toBe(120);

  // A longer period never pushes an earlier due slot back.
  writeServeToml(f.vault, "[serve]\nsync_period_s = 3600\n");
  await runServeDaemon(f.db, f.vault, {
    once: true,
    http: false,
    rails: ["journal-prune"],
    now: () => now,
  });
  expect(listSchedules(f.db).find((row) => row.rail === "sync")).toMatchObject({
    period_s: 3600,
    next_run_at: "2026-09-24T12:02:00.000Z",
  });
});
