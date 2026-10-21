import { afterEach, expect, test } from "bun:test";
import { accept, createBudgetTracker, registerConnection, setSourceGrant } from "../../src/index";
import { openLedger } from "../../src/ledger/db";
import { commitExtractCursor, journalExtractBatch, mineLiveDrafts, readExtractCursor } from "../../src/serve/extract";
import { bindSourceModelPort } from "../../src/ledger/source-grants";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { runWritePass, STOP_REQUESTED } from "../../src/serve/write-pass";
import { validEvent } from "../fixtures";
import { ENDPOINT, MODEL, fixtureProducer, recordText, throughputVault } from "./throughput-fixture";

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
  const pass = (options: { now?: () => string; stopRequested?: () => boolean; producer?: typeof model.producer } = {}) => runWritePass(db, vault.vault, {
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
  const f = fixture(1030);
  let polls = 0;
  const result = await f.pass({ stopRequested: () => { polls++; return stop === "signal" && polls > 1; },
    now: () => stop === "time" && polls > 1 ? "2026-10-21T00:01:00Z" : "2026-10-21T00:00:00Z" });
  expect(result.model.calls).toBe(0);
  expect(result.stopped).toBe(stop === "signal" ? STOP_REQUESTED : null);
  expect(deferredCount(f.db)).toBe(1024);
  expect(readExtractCursor(f.db)?.endsWith(f.ids[1023]!)).toBe(true);
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


test("a newly authorized deferred source is selected before unchanged denied queue prefixes", async()=>{
  const f=fixture(32),source="01J00000000000000000000SRC";
  const policy={purposes:["capture","recall","derive","extract"] as const,allowed_fields:["text","subjects","attachments","metadata"] as const,retention:"persistent_owned_until_revoked" as const,sensitivity_floor:"public" as const};
  setSourceGrant(f.db,{source_key:source,expected_revision:1,operation_id:"defer-tail",policy:{...policy,purposes:[...policy.purposes],allowed_fields:[...policy.allowed_fields],egress:"local_only"}});
  expect((await f.pass()).model.calls).toBe(0);
  expect(deferredCount(f.db)).toBe(33);
  setSourceGrant(f.db,{source_key:source,expected_revision:2,operation_id:"permit-tail",policy:{...policy,purposes:[...policy.purposes],allowed_fields:[...policy.allowed_fields],egress:{model_endpoint:ENDPOINT,model:MODEL,external_retention:"provider_managed"}}});
  const resumed=await f.pass();
  expect(resumed.errors).toEqual([]);
  expect(resumed.model.calls).toBe(1);
  expect(f.model.calls.map(call=>call.event_ids)).toEqual([[f.ids[32]!]]);
  expect(deferredCount(f.db)).toBe(32);
});


test("denied prefix queue and cursor roll back together, then resume without duplicate requests",async()=>{
  const f=fixture(16),mined=await mineLiveDrafts(f.db,f.model.producer);
  expect(mined.denied_frontier).toBeDefined();
  f.db.exec(`CREATE TRIGGER fail_deferred_insert BEFORE INSERT ON extract_deferred_inputs WHEN NEW.event_id='${f.ids[8]}' BEGIN SELECT RAISE(ABORT,'synthetic queue failure'); END`);
  expect(()=>commitExtractCursor(f.db,mined)).toThrow("synthetic queue failure");
  expect(deferredCount(f.db)).toBe(0);
  expect(readExtractCursor(f.db)).toBeNull();
  f.db.exec("DROP TRIGGER fail_deferred_insert");
  expect(commitExtractCursor(f.db,mined)).toBe(true);
  expect(commitExtractCursor(f.db,mined)).toBe(false);
  expect((await f.pass()).model.calls).toBe(1);
  expect(f.model.calls.map(call=>call.event_ids)).toEqual([[f.ids[16]!]]);
  expect(deferredCount(f.db)).toBe(16);
});

for(const mutation of ["grant","binding","purge"] as const)test(`denied prefix refuses a changed ${mutation} before the checkpoint`,async()=>{
  const f=fixture(16);let mined=await mineLiveDrafts(f.db,f.model.producer);
  expect(mined.denied_frontier).toBeDefined();
  if(mutation==="grant")setSourceGrant(f.db,{source_key:"01J00000000000000000000HVD",expected_revision:1,operation_id:"permit-racing-prefix",policy:{purposes:["capture","derive","extract","recall"],allowed_fields:["text","subjects","attachments","metadata"],retention:"persistent_owned_until_revoked",sensitivity_floor:"public",egress:{model_endpoint:ENDPOINT,model:MODEL,external_retention:"provider_managed"}}});
  else if(mutation==="binding")mined={...mined,denied_frontier:{...mined.denied_frontier!,producer:bindSourceModelPort({...f.model.producer},{model_endpoint:ENDPOINT,model:"another-model"})}};
  else f.db.query("DELETE FROM events WHERE event_id=?").run(f.ids[4]!);
  if(mutation==="grant")expect(()=>commitExtractCursor(f.db,mined)).toThrow("source authorization changed");
  else expect(commitExtractCursor(f.db,mined)).toBe(false);
  expect(readExtractCursor(f.db)).toBeNull();
  expect(deferredCount(f.db)).toBe(0);
  expect(f.model.calls).toHaveLength(0);
});

test("a model binding change revisits unchanged-revision denied sources",async()=>{
  const f=fixture(16);
  // Both sources are denied for this concrete model destination.
  const other=bindSourceModelPort({...f.model.producer},{model_endpoint:ENDPOINT,model:"other-model"});
  expect((await f.pass({producer:other})).model.calls).toBe(0);
  expect(deferredCount(f.db)).toBe(17);
  expect((await f.pass()).model.calls).toBe(1);
  expect(f.model.calls.map(call=>call.event_ids)).toEqual([[f.ids[16]!]]);
  expect(deferredCount(f.db)).toBe(16);
});
