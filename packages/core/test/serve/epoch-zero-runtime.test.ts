import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accept, bindEpochZeroProducerPort, bindSourceModelPort, initVault,
  registerConnection, setSourceGrant, sourcePolicyEpoch,
} from "../../src/index";
import type { ProducerPort, ProducerV2Port } from "../../src/index";
import { openLedger } from "../../src/ledger/db";
import { sourceEventsAllowed } from "../../src/ledger/source-grants";
import { createBudgetTracker } from "../../src/canon/budget";
import { journalExtractBatch, mineLiveDrafts, readDurableExtractBatch } from "../../src/serve/extract";
import { runWritePass } from "../../src/serve/write-pass";
import { validEvent } from "../fixtures";
import { putEvent } from "../claims/helpers";
import { ulid } from "../../src/util/ulid";

const binding = { model_endpoint: "https://synthetic.example.test/v1/chat/completions", model: "review-runtime" };
function fixture() {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-review-epoch-"));
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  let calls = 0;
  const port = bindSourceModelPort<ProducerPort>({
    descriptor: { id: "kizuki.producer.review", kind: "producer", contract: "kizuki.producer/v1",
      contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    async produce(input) {
      calls++;
      return { status: "ok", claims: input.events.map(event => ({
        kind: "claim", subject: "person:review", predicate: "employment.role", object: "coordinator",
        polarity: "positive", body: "Review is a coordinator.", valid_from: null, valid_to: null,
        confidence: 0.8, sensitivity: "private", event_ids: [event.event_id],
      })), usage: { calls: 1, input_tokens: 1, output_tokens: 1 } };
    },
  }, binding);
  function grant() {
    const source = ulid();
    registerConnection(db, "kizuki.fixture", source);
    setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: `review-${source}`, policy: {
      purposes: ["capture", "recall", "derive", "extract"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: { ...binding, external_retention: "provider_managed" }, sensitivity_floor: "public",
    } });
    return source;
  }
  function managed() {
    const source = grant();
    const event = accept(db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: ulid(),
      text: "Review is a coordinator." }, { source: { source_key: source, expected_revision: 1 } });
    if (event.status !== "stored") throw new Error("fixture capture failed");
    return event.event.event_id;
  }
  return { db, vault, port, grant, managed, calls: () => calls,
    run: (producer: ProducerPort | ProducerV2Port = port) => runWritePass(db, vault, {
      producer, model_ref: "fixture:review", claims: { db },
      budget: createBudgetTracker({ canon_writes_per_run: 0 }),
    }),
    close: () => { db.close(); rmSync(vault, { recursive: true, force: true }); } };
}

test("stale epoch-zero mark survives actual metrics wrapping even when model and event remain authorized", async () => {
  const f = fixture();
  try {
    bindEpochZeroProducerPort(f.port);
    const event = f.managed();
    expect(sourcePolicyEpoch(f.db)).toBeGreaterThan(0);
    expect(f.db.query("SELECT count(*) AS n FROM source_event_bindings WHERE event_id=?").get(event)).toEqual({ n: 1 });
    expect(sourceEventsAllowed(f.db, [event], { owner: false, purpose: "extract", model: true, port: f.port })).toBe(true);
    const result = await f.run();
    expect(f.calls()).toBe(0);
    expect(result.stopped).toBe("model:source authorization unavailable");
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test("authorized unmarked v1 remains usable through actual write pass at managed epoch", async () => {
  const f = fixture();
  try {
    f.managed(); await f.run();
    expect(f.calls()).toBe(1);
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT count(*) AS n FROM claim_v2_support").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test("epoch-zero pending decision cannot replay after managed consent arrives", async () => {
  const f = fixture();
  try {
    bindEpochZeroProducerPort(f.port); putEvent(f.db);
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.port), "fixture:review", f.port);
    const before = f.db.query("SELECT * FROM extract_batches").all();
    f.grant(); await f.run();
    expect(f.calls()).toBe(1);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual(before);
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test("saved v1 codec survives runtime v2 replacement and exact endpoint remains required", async () => {
  const f = fixture();
  try {
    f.managed(); journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.port), "fixture:review", f.port);
    const before = f.db.query("SELECT * FROM extract_batches").all();
    const makeV2 = (destination: typeof binding): ProducerV2Port => bindSourceModelPort({
      descriptor: { ...f.port.descriptor, contract: "kizuki.producer/v2", contract_minor: 0 },
      model_ref: "fixture:review", health: f.port.health, close: f.port.close,
      produce: async () => { throw new Error("saved decision must never call replacement producer"); },
    }, destination);
    for (const destination of [
      { ...binding, model: "wrong-model" },
      { ...binding, model_endpoint: "https://other.synthetic.example.test/v1/chat/completions" },
    ]) {
      await f.run(makeV2(destination));
      expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual(before);
      expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
    }
    expect(readDurableExtractBatch(f.db, makeV2(binding))?.filing_version).toBe(1);
    await f.run(makeV2(binding));
    expect(f.calls()).toBe(1);
    expect(f.db.query("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT count(*) AS n FROM claim_v2_support").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});
