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

test("52k denied records reach the authorized tail within one bounded scheduler pass", async () => {
  const started=performance.now(), f=fixture(52_000), seeded=performance.now();
  const result=await f.pass({now:()=>"2026-10-21T00:00:00Z"});
  console.log(JSON.stringify({fixture_records:52_001,seed_ms:seeded-started,pass_ms:performance.now()-seeded,model_calls:result.model.calls,deferred:deferredCount(f.db)}));
  expect(result.errors).toEqual([]);
  expect(result.model.calls).toBe(1);
  expect(result.claims_extracted).toBe(1);
  expect(f.model.calls.map(call=>call.event_ids)).toEqual([[f.ids[52_000]!]]);
  expect(deferredCount(f.db)).toBe(52_000);
  expect(readExtractCursor(f.db)?.endsWith(f.ids[52_000]!)).toBe(true);
},600_000);
