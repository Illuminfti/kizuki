import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { accept } from "../../src/ledger/ledger";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { initVault } from "../../src/vault/init";
import { validEvent } from "../fixtures";
import {
  EXTRACT_RESPONSE_V2_SCHEMA,
  PRODUCER_V2_CONTRACT,
  type ProduceInputV2,
  type ProducerV2Port,
} from "../../src/contracts/producer-v2";
import {
  journalExtractBatch,
  mineLiveDrafts,
  readDurableExtractBatch,
  readExtractCursor,
} from "../../src/serve/extract";
import { canonicalJson } from "../../src/util/hash";
import { EXTRACT_MAX_OUTPUT_TOKENS } from "../../src/producer/model";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "extract-v2-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const ledger = join(vault, ".kizuki", "kizuki.db");
  let db = openLedger(ledger);
  const accepted = accept(db, {
    ...validEvent(),
    connector_id: "kizuki.fixture",
    source_record_id: "world-one",
    text: "Mira explains flux.",
    subjects: [],
  });
  if (accepted.status !== "stored") throw new Error("fixture event was not stored");
  const calls = { count: 0 };
  const producer: ProducerV2Port = {
    descriptor: {
      id: "kizuki.producer.fixture-v2",
      kind: "producer",
      contract: PRODUCER_V2_CONTRACT,
      contract_minor: 0,
      supports: ["model"],
      requires_lease: false,
      optional_package: null,
    },
    model_ref: "fixture:world-v2",
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => undefined,
    async produce(input: ProduceInputV2) {
      calls.count += 1;
      expect(input.events).toEqual([{ event_id: accepted.event.event_id, text: "Mira explains flux." }]);
      expect(input.supplied_refs).toEqual([]);
      expect(input.predicates).toContainEqual({ id: "concept.definition", object_kinds: ["literal"] });
      return {
        status: "ok",
        response: {
          schema: EXTRACT_RESPONSE_V2_SCHEMA,
          mentions: [{
            id: "m0",
            label: "Mira",
            anchor: { event_id: accepted.event.event_id, start_utf16: 0, end_utf16: 4 },
            candidate_refs: [],
          }],
          claims: [{
            id: "c0",
            subject: { kind: "mention", id: "m0" },
            predicate: "concept.definition",
            object: { kind: "literal", value: "A synthetic transformation." },
            perspective: {
              holder: null,
              speaker: null,
              addressee: null,
              mode: "asserted",
              interpretation: "explicit",
              anchors: [],
            },
            context: [],
            polarity: "positive",
            body: "Mira defines flux as a synthetic transformation.",
            valid_from: null,
            valid_to: null,
            temporal_basis: "unknown",
            confidence: 0.8,
            sensitivity: "personal",
            anchors: [{ event_id: accepted.event.event_id, start_utf16: 0, end_utf16: 4 }],
          }],
        },
        usage: { calls: 1, input_tokens: 20, output_tokens: 30 },
      };
    },
  };
  return {
    vault,
    accepted: accepted.event,
    calls,
    producer,
    get db() { return db; },
    reopen() { db.close(); db = openLedger(ledger); },
    close() { db.close(); },
  };
}

test("v2 extraction journals normalized world drafts and reopens without another model call", async () => {
  const f = fixture();
  try {
    const mined = await mineLiveDrafts(f.db, f.producer);
    expect(mined.mined).toEqual({ status: "ok", count: 1 });
    journalExtractBatch(f.db, mined, f.producer.model_ref, f.producer);
    const row = f.db.query<{ drafts: string; integrity: string }, []>(
      "SELECT drafts,integrity FROM extract_batches",
    ).get();
    expect(row?.integrity).toMatch(/^atomic-v2:[a-f0-9]{64}$/);
    expect(row?.drafts).not.toContain("Mira explains flux.");
    expect(row?.drafts).not.toContain('"m0"');
    expect(JSON.parse(row!.drafts)).toHaveLength(1);
    expect(f.calls.count).toBe(1);

    f.reopen();
    const durable = readDurableExtractBatch(f.db, f.producer);
    expect(durable?.filing_version).toBe(2);
    expect(durable?.filing_drafts).toHaveLength(1);
    expect(f.calls.count).toBe(1);
  } finally {
    f.close();
  }
});

test("v2 extraction reserves the producer output ceiling for a complete typed response", async () => {
  const f = fixture();
  try {
    const budgets: ProduceInputV2["budget"][] = [];
    const producer: ProducerV2Port = { ...f.producer, produce: input => { budgets.push(input.budget); return f.producer.produce(input); } };
    expect((await mineLiveDrafts(f.db, producer)).mined).toEqual({ status: "ok", count: 1 });
    expect(budgets).toEqual([{ max_calls: 1, max_input_tokens: 8_000, max_output_tokens: EXTRACT_MAX_OUTPUT_TOKENS }]);
  } finally {
    f.close();
  }
});

test("v2 durable parsing rejects a re-signed semantic and rendering disagreement", async () => {
  const f = fixture();
  try {
    const mined = await mineLiveDrafts(f.db, f.producer);
    journalExtractBatch(f.db, mined, f.producer.model_ref, f.producer);
    const row = f.db.query<Record<string, string | null>, []>("SELECT * FROM extract_batches").get()!;
    const drafts = JSON.parse(row.drafts!) as Array<Record<string, unknown>>;
    drafts[0]!.body = "A forged rendering.";
    const raw = canonicalJson(drafts);
    const digest = createHash("sha256").update("kizuki.extract-filing/atomic-v2\0").update(canonicalJson({
      decision_schema: "kizuki.extract-decision/v2",
      producer_contract: "kizuki.producer/v2",
      draft_schema: "kizuki.claim/v2",
      integrity_schema: "kizuki.extract-integrity/v2",
      previous_cursor: null,
      cursor: row.cursor,
      model_ref: row.model_ref,
      input_ids: JSON.parse(row.input_ids!),
      mode: row.batch_mode,
      model_inputs: JSON.parse(row.model_inputs!),
      deferred_inputs: JSON.parse(row.deferred_inputs!),
      outcome: row.outcome,
      drafts,
    })).digest("hex");
    f.db.query("UPDATE extract_batches SET drafts=?,integrity=?").run(raw, `atomic-v2:${digest}`);
    expect(() => readDurableExtractBatch(f.db, f.producer)).toThrow("durable extraction batch is corrupt");
  } finally {
    f.close();
  }
});

test("v2 rejects an impossible first event without a model call or cursor advance", async () => {
  const root = mkdtempSync(join(tmpdir(), "extract-v2-oversize-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const accepted = accept(db, { ...validEvent(), source_record_id: "oversize", text: "x".repeat(24_001), subjects: [] });
  if (accepted.status !== "stored") throw new Error("fixture event was not stored");
  let calls = 0;
  const producer: ProducerV2Port = {
    descriptor: { id: "kizuki.producer.fixture-v2", kind: "producer", contract: PRODUCER_V2_CONTRACT, contract_minor: 0,
      supports: ["model"], requires_lease: false, optional_package: null },
    model_ref: "fixture:world-v2",
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => undefined,
    produce: async () => { calls += 1; throw new Error("oversized input reached the producer"); },
  };
  try {
    const mined = await mineLiveDrafts(db, producer);
    expect(mined.mined).toEqual({ status: "rejected", reason: "producer v2 input exceeds structural or budget limits" });
    expect(calls).toBe(0);
    expect(readExtractCursor(db)).toBeNull();
    expect(db.query("SELECT * FROM extract_batches").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("purging the sole v2 input removes its unfiled decision without remine", async () => {
  const f = fixture();
  try {
    const mined = await mineLiveDrafts(f.db, f.producer);
    journalExtractBatch(f.db, mined, f.producer.model_ref, f.producer);
    purgeEvents(f.db, f.vault, { event_id: f.accepted.event_id }, "synthetic v2 source purge");
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(f.calls.count).toBe(1);
    expect(readExtractCursor(f.db)).toBeNull();
  } finally {
    f.close();
  }
});

test("v2 extraction sends at most four records per call and keeps the rest beyond the cursor", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 5; index += 1) {
      const stored = accept(f.db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: `world-extra-${index}`, text: `Synthetic record ${index}.`, subjects: [] });
      if (stored.status !== "stored") throw new Error("fixture event was not stored");
    }
    const seen: number[] = [];
    const producer: ProducerV2Port = { ...f.producer, produce: async input => {
      seen.push(input.events.length);
      return { status: "ok", response: { schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [], claims: [] }, usage: { calls: 1, input_tokens: 1, output_tokens: 1 } };
    } };
    const mined = await mineLiveDrafts(f.db, producer);
    expect(seen).toEqual([4]);
    expect(mined.input_ids).toHaveLength(4);
  } finally {
    f.close();
  }
});
