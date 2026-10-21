import { afterEach, expect, test } from "bun:test";
import { accept, createBudgetTracker, registerConnection, setSourceGrant } from "../../src/index";
import { openLedger } from "../../src/ledger/db";
import { journalExtractBatch, mineLiveDrafts, readExtractCursor } from "../../src/serve/extract";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { runWritePass, STOP_REQUESTED } from "../../src/serve/write-pass";
import { validEvent } from "../fixtures";
import { fixtureProducer, recordText, throughputVault } from "./throughput-fixture";

const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });

function fixture(denied: number) {
  const vault = throughputVault(0), db = openLedger(vault.ledger);
  dispose.push(vault.dispose, () => db.close());
  const held = "01J00000000000000000000HVD", allowed = "01J00000000000000000000SRC";
  registerConnection(db, "kizuki.fixture", held);
  setSourceGrant(db, { source_key: held, expected_revision: 0, operation_id: "held-prefix", policy: {
    purposes: ["capture", "recall", "derive", "extract"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
  } });
  const ids = db.transaction(() => Array.from({ length: denied + 1 }, (_, index) => {
    const result = accept(db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: `prefix-${index}`,
      text: recordText(index), subjects: [] }, { source: { source_key: index < denied ? held : allowed, expected_revision: 1 } });
    if (result.status !== "stored") throw Error("synthetic capture failed");
    return result.event.event_id;
  }))();
  const model = fixtureProducer(() => db);
  const pass = (options: { now?: () => string; stopRequested?: () => boolean } = {}) => runWritePass(db, vault.vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 0 }), producer: model.producer, claims: { db },
    extraction: { ...DEFAULT_EXTRACTION_CONFIG, max_calls_per_pass: 1, records_per_request: 2 }, ...options,
  });
  return { db, ids, model, pass };
}

const deferredCount = (db: ReturnType<typeof openLedger>) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM extract_deferred_inputs").get()!.n;

test("denied frontier records do not spend the model-call budget before an authorized tail", async () => {
  const f = fixture(16);
  const result = await f.pass();
  expect(result.errors).toEqual([]);
  expect(result.model.calls).toBe(1);
  expect(result.claims_extracted).toBe(1);
  expect(f.model.calls.map(call => call.event_ids)).toEqual([[f.ids[16]!]]);
  expect(deferredCount(f.db)).toBe(16);
  expect(readExtractCursor(f.db)?.endsWith(f.ids[16]!)).toBe(true);
});

for (const stop of ["signal", "time"] as const) test(`denied frontier scanning observes ${stop} between committed steps`, async () => {
  const f = fixture(16);
  let polls = 0;
  const result = await f.pass({ stopRequested: () => { polls++; return stop === "signal" && polls > 1; },
    now: () => stop === "time" && polls > 1 ? "2026-10-21T00:01:00Z" : "2026-10-21T00:00:00Z" });
  expect(result.model.calls).toBe(0);
  expect(result.stopped).toBe(stop === "signal" ? STOP_REQUESTED : null);
  expect(deferredCount(f.db)).toBe(8);
  expect(readExtractCursor(f.db)?.endsWith(f.ids[7]!)).toBe(true);
});

test("a frozen clock drains fresh denied pages and stops at the retained denied queue", async () => {
  const f = fixture(16);
  const now = () => "2026-10-21T00:00:00Z";
  const first = await f.pass({ now });
  expect(first.model.calls).toBe(1);
  expect(first.errors).toEqual([]);
  expect(deferredCount(f.db)).toBe(16);
  let polls = 0;
  const resumed = await f.pass({ now, stopRequested: () => { if (++polls > 3) throw Error("denied queue spun"); return false; } });
  expect(resumed.model.calls).toBe(0);
  expect(resumed.errors).toEqual([]);
  expect(f.model.calls.map(call => call.event_ids)).toEqual([[f.ids[16]!]]);
  expect(readExtractCursor(f.db)?.endsWith(f.ids[16]!)).toBe(true);
});

test("replay with denied inputs retains the step cap and does not repeat a model request", async () => {
  const f = fixture(4);
  const tail = accept(f.db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: "later-tail",
    text: recordText(5), subjects: [] }, { source: { source_key: "01J00000000000000000000SRC", expected_revision: 1 } });
  if (tail.status !== "stored") throw Error("synthetic capture failed");
  const mined = await mineLiveDrafts(f.db, f.model.producer, { ...DEFAULT_EXTRACTION_CONFIG, records_per_request: 1 });
  expect(mined.mined.status).toBe("ok");
  expect(journalExtractBatch(f.db, mined, f.model.producer.model_ref, f.model.producer).journaled).toBe(true);
  const replayed = await f.pass({ now: () => "2026-10-21T00:00:00Z" });
  expect(replayed.model.calls).toBe(0);
  expect(replayed.errors).toEqual([]);
  expect(deferredCount(f.db)).toBe(4);
  expect(readExtractCursor(f.db)?.endsWith(f.ids[4]!)).toBe(true);
  expect(f.model.calls).toHaveLength(1);
  const resumed = await f.pass();
  expect(resumed.model.calls).toBe(1);
  expect(f.model.calls.map(call => call.event_ids)).toEqual([[f.ids[4]!], [tail.event.event_id]]);
});
