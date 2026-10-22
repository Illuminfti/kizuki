import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR } from "../../src/producer/model-v2";
import { modelProducerInputTokenOverhead } from "../../src/producer/fingerprint";
import { scriptedLlm, temporaryProducerContext } from "../producer/helpers";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { readRejections } from "../../src/serve/extract-rejections";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { createBudgetTracker } from "../../src/canon/budget";
import {
  EXTRACT_RESPONSE_V2_SCHEMA,
  PRODUCER_V2_CONTRACT,
  type ProduceInputV2,
  type ProducerV2Port,
} from "../../src/contracts/producer-v2";
import { registerConnection } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import {
  bindLocalSourcePort,
  bindSourceModelPort,
  revokeSourceGrant,
  setSourceGrant,
} from "../../src/ledger/source-grants";
import { readWorldView } from "../../src/serving/world-view";
import {
  journalExtractBatch,
  mineLiveDrafts,
  readExtractCursor,
} from "../../src/serve/extract";
import { runWritePass } from "../../src/serve/write-pass";
import { ulid } from "../../src/util/ulid";
import { initVault } from "../../src/vault/init";
import { validEvent } from "../fixtures";
import { FixtureVectorPort } from "../claims/helpers";

const roots: string[] = [];
const endpoint = "https://models.example.test/v1/chat/completions";
const model = "fixture-world-model";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(supplied = false, role = false, text?: string) {
  const root = mkdtempSync(join(tmpdir(), "extract-v2-runtime-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const ledger = join(vault, ".kizuki", "kizuki.db");
  let db = openLedger(ledger);
  const sourceKey = ulid();
  registerConnection(db, "kizuki.fixture", sourceKey);
  setSourceGrant(db, {
    source_key: sourceKey,
    expected_revision: 0,
    operation_id: `grant-${sourceKey}`,
    policy: {
      purposes: ["capture", "recall", "derive", "extract"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: {
        model_endpoint: endpoint,
        model,
        external_retention: "provider_managed",
      },
      sensitivity_floor: "public",
    },
  });
  const accepted = accept(db, {
    ...validEvent(),
    connector_id: "kizuki.fixture",
    source_record_id: "world-runtime",
    text: text ?? (role ? "Ada joined the orchard library project." : "Flux is a synthetic transformation."),
    subjects: supplied ? [{ subject_id: "concept:flux", role: "about", display_name: "Flux" }] : [],
  }, { source: { source_key: sourceKey, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("fixture capture failed");

  const calls = { count: 0 };
  const producer = bindSourceModelPort<ProducerV2Port>({
    descriptor: {
      id: "kizuki.producer.fixture-v2",
      kind: "producer",
      contract: PRODUCER_V2_CONTRACT,
      contract_minor: 0,
      supports: ["model"],
      requires_lease: false,
      optional_package: null,
    },
    model_ref: model,
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => undefined,
    async produce(input: ProduceInputV2) {
      calls.count += 1;
      const eventId = input.events[0]!.event_id;
      const anchor = { event_id: eventId, start_utf16: 0, end_utf16: role ? 3 : 4 };
      if (supplied) {
        expect(input.supplied_refs).toEqual([{ id: "s0", anchors: [anchor] }]);
        expect(JSON.stringify(input)).not.toContain("concept:flux");
      }
      const claim = (id: string, predicate: string, object: { kind: "literal"; value: string } | { kind: "vocabulary"; ref: { kind: "vocabulary"; id: string } }, body: string) => ({
        id,
        subject: supplied ? { kind: "supplied" as const, id: "s0" } : { kind: "mention" as const, id: "m0" },
        predicate,
        object,
        perspective: { holder: null, speaker: null, addressee: null, mode: "asserted" as const, interpretation: "explicit" as const, anchors: [] },
        context: [],
        polarity: "positive" as const,
        body,
        valid_from: null,
        valid_to: null,
        temporal_basis: "unknown" as const,
        confidence: 0.8,
        sensitivity: "public" as const,
        anchors: [anchor],
      });
      return {
        status: "ok" as const,
        response: {
          schema: EXTRACT_RESPONSE_V2_SCHEMA,
          mentions: supplied ? [] : [{ id: "m0", label: role ? "Ada" : "Flux", anchor, candidate_refs: [] }],
          claims: role ? [claim("role", "employment.role", { kind: "literal", value: "orchard library collaborator" }, "Ada is an orchard library collaborator.")] : [
            claim("c0", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }, "Flux is a concept."),
            claim("c1", "concept.label", { kind: "literal", value: "Flux" }, "The concept is called Flux."),
            claim("c2", "concept.definition", { kind: "literal", value: "A synthetic transformation." }, "Flux is a synthetic transformation."),
          ],
        },
        usage: { calls: 1, input_tokens: 20, output_tokens: 30 },
      };
    },
  }, { model_endpoint: endpoint, model });
  const options = (retrieval?: FixtureVectorPort) => ({
    producer,
    model_ref: producer.model_ref,
    claims: { db, ...(retrieval === undefined ? {} : { retrieval }) },
    budget: createBudgetTracker({ canon_writes_per_run: 8 }),
  });
  return {
    vault,
    ledger,
    sourceKey,
    eventId: accepted.event.event_id,
    calls,
    producer,
    options,
    get db() { return db; },
    reopen() { db.close(); db = openLedger(ledger); },
    close() { db.close(); },
  };
}

function discoverConcept(f: ReturnType<typeof fixture>) {
  const found = readWorldView(
    { db: f.db, vaultPath: f.vault, principal: OWNER },
    { operation: "find_concepts", label: "Flux", valid: { kind: "all" }, knownAt: { kind: "current" } },
  );
  if ("status" in found || found.result.status === "unavailable" || !("matches" in found.result.data)) {
    throw new Error("world concept was not discoverable");
  }
  const ref = found.result.data.matches[0]?.ref;
  if (ref === undefined) throw new Error("world concept ref missing");
  return readWorldView(
    { db: f.db, vaultPath: f.vault, principal: OWNER },
    { operation: "concept", concept: ref, valid: { kind: "all" }, knownAt: { kind: "current" } },
  );
}

test("v2 write pass atomically files typed claims, outbox, cursor and public world view", async () => {
  const f = fixture();
  const observer = openLedger(f.ledger);
  try {
    const published: Array<{ claims: number; pending: number; cursor: string | null; batches: number }> = [];
    class ObservingRetrieval extends FixtureVectorPort {
      override async upsert(docs: Parameters<FixtureVectorPort["upsert"]>[0]) {
        published.push({
          claims: observer.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n,
          pending: observer.query<{ n: number }, []>("SELECT count(*) AS n FROM retrieval_ops WHERE state='pending'").get()!.n,
          cursor: readExtractCursor(observer),
          batches: observer.query<{ n: number }, []>("SELECT count(*) AS n FROM extract_batches").get()!.n,
        });
        return super.upsert(docs);
      }
    }
    const retrieval = bindLocalSourcePort(new ObservingRetrieval(), { store_id: "local:extract-v2-runtime" });
    const result = await runWritePass(f.db, f.vault, f.options(retrieval));
    expect(result.errors).toEqual([]);
    expect(result.claims_extracted).toBe(3);
    expect(f.calls.count).toBe(1);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 3 });
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM retrieval_ops").get()).toEqual({ n: 3 });
    expect(published).toHaveLength(3);
    expect(published.every(snapshot => snapshot.claims === 3 && snapshot.pending > 0 && snapshot.cursor?.includes(f.eventId) === true && snapshot.batches === 0)).toBe(true);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).toContain(f.eventId);
    expect(JSON.stringify(discoverConcept(f))).toContain("A synthetic transformation.");
  } finally {
    observer.close();
    f.close();
  }
});

test("v2 filing rollback survives reopen and replays without another provider call", async () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER fail_world_support BEFORE INSERT ON claim_v2_support BEGIN SELECT RAISE(ABORT,'atomic interruption'); END");
    await expect(runWritePass(f.db, f.vault, f.options())).rejects.toThrow("atomic interruption");
    expect(f.calls.count).toBe(1);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM retrieval_ops").get()).toEqual({ n: 0 });
    expect(readExtractCursor(f.db)).toBeNull();
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 1 });
    f.db.exec("DROP TRIGGER fail_world_support");
    f.reopen();
    const replay = await runWritePass(f.db, f.vault, f.options());
    expect(replay.errors).toEqual([]);
    expect(f.calls.count).toBe(1);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 3 });
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).toContain(f.eventId);
    expect(JSON.stringify(discoverConcept(f))).toContain("A synthetic transformation.");
  } finally {
    f.close();
  }
});

test("typed production input preserves the existing registered literal predicates", async () => {
  const f = fixture(false, true);
  try {
    const result = await runWritePass(f.db, f.vault, f.options());
    expect(result.errors).toEqual([]);
    expect(result.claims_extracted).toBe(1);
    expect(result.canon_writes).toBe(1);
    expect(f.calls.count).toBe(1);
    const stored = f.db.query<{ payload: string }, []>("SELECT payload FROM claim_v2_semantics").get();
    expect(JSON.parse(stored!.payload)).toMatchObject({ predicate: "employment.role", object: { kind: "literal", value: "orchard library collaborator" } });
    expect(f.db.query<{ body: string; object: string | null }, []>("SELECT body,object FROM claims").get()).toEqual({ body: "", object: null });
    expect(f.db.query<{ receipt_id: string | null }, []>("SELECT receipt_id FROM claims").get()?.receipt_id).not.toBeNull();
  } finally { f.close(); }
});

test("source-qualified supplied handles survive durable replay and actual typed filing", async () => {
  const f = fixture(true);
  try {
    const mined = await mineLiveDrafts(f.db, f.producer);
    expect(mined.mined).toEqual({ status: "ok", count: 3 });
    journalExtractBatch(f.db, mined, f.producer.model_ref, f.producer);
    const raw = f.db.query<{ drafts: string }, []>("SELECT drafts FROM extract_batches").get()!.drafts;
    const drafts = JSON.parse(raw);
    expect(drafts.every((draft: { semantic: { subject: unknown } }) => JSON.stringify(draft.semantic.subject) === JSON.stringify({
      id: "concept:flux", kind: "supplied", namespace: { connector_id: "kizuki.fixture", source_key: f.sourceKey },
    }))).toBe(true);
    expect(raw).not.toContain('"s0"');
    f.reopen();
    const result = await runWritePass(f.db, f.vault, f.options());
    expect(result.errors).toEqual([]);
    // Replay files the previous decision; its extraction/model counters stay zero.
    expect(result.claims_extracted).toBe(0);
    expect(result.model.calls).toBe(0);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims WHERE is_world_typed=1").get()).toEqual({ n: 3 });
    expect(f.calls.count).toBe(1);
    expect(JSON.stringify(discoverConcept(f))).toContain("A synthetic transformation.");
  } finally { f.close(); }
});

test("revoked source cannot file a pending v2 decision", async () => {
  const f = fixture();
  try {
    const mined = await mineLiveDrafts(f.db, f.producer);
    expect(mined.mined).toEqual({ status: "ok", count: 3 });
    journalExtractBatch(f.db, mined, f.producer.model_ref, f.producer);
    revokeSourceGrant(f.db, {
      source_key: f.sourceKey,
      expected_revision: 1,
      operation_id: "revoke-before-v2-file",
    });
    const result = await runWritePass(f.db, f.vault, f.options());
    expect(result.stopped).toBe("source:durable_extraction_authorization_pending");
    expect(f.calls.count).toBe(1);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
    expect(readExtractCursor(f.db)).toBeNull();
  } finally {
    f.close();
  }
});

function budgetProducer(f: ReturnType<typeof fixture>, overhead: number, usage: { input_tokens: number; output_tokens: number }) {
  const context = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR);
  let wire = 0;
  const requests: Parameters<ReturnType<typeof scriptedLlm>["complete"]>[0][] = [];
  const llm = { ...scriptedLlm(() => "unused"), input_token_overhead: overhead, async complete(request: typeof requests[number]) {
    requests.push(request);
    return { model, text: '{"schema":"kizuki.model-extraction/quote-anchors-v1","mentions":[],"claims":[]}', usage };
  } };
  const producer = bindSourceModelPort(createModelProducerV2Port(context.ctx, { llm, onWireReceipt() { wire++; } }), { model_endpoint: endpoint, model });
  return { producer, requests, wire: () => wire, cleanup: context.cleanup };
}

test("observed typed producer with no reserve capacity stops without calls, skipped records, history or checkpoint progress", async () => {
  const f = fixture(false, false, "x".repeat(40_000)), bound = budgetProducer(f, 24_000, { input_tokens: 1, output_tokens: 1 });
  try {
    expect(modelProducerInputTokenOverhead(bound.producer)).toBe(24_000);
    const result = await runWritePass(f.db, f.vault, { ...f.options(), producer: bound.producer });
    expect(result.errors).toContain("budget_exhausted");
    expect(result.model.calls).toBe(0);
    expect(bound.requests).toHaveLength(0);
    expect(readExtractCursor(f.db)).toBeNull();
    expect(readRejections(f.db, new Date().toISOString())).toBeNull();
    expect(result.oversized.skipped).toBe(0);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM claims").all()).toEqual([]);
  } finally { bound.cleanup(); f.close(); }
});

for (const dimension of ["input_tokens", "output_tokens"] as const) {
  test(`observed typed measured ${dimension} excess retains usage and refuses all checkpoint or claim writes without retry`, async () => {
    const f = fixture();
    const usage = { input_tokens: 40, output_tokens: 40, [dimension]: dimension === "input_tokens" ? 32_001 : 2_001 };
    const bound = budgetProducer(f, 24_000, usage);
    try {
      const result = await runWritePass(f.db, f.vault, { ...f.options(), producer: bound.producer,
        extraction: { ...DEFAULT_EXTRACTION_CONFIG, max_input_tokens: 32_000, max_output_tokens: 2_000 } });
      expect(result.errors).toContain("budget_exhausted");
      expect(result.model).toMatchObject({ calls: 1, ...usage });
      expect(bound.requests).toHaveLength(1);
      expect(bound.wire()).toBe(0);
      expect(readExtractCursor(f.db)).toBeNull();
      expect(readRejections(f.db, new Date().toISOString())).toBeNull();
      expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
      expect(f.db.query("SELECT * FROM claims").all()).toEqual([]);
      expect(result.claims_written).toBe(0);
    } finally { bound.cleanup(); f.close(); }
  });
}

test("host segment planner shrinks quoted text by the trusted reserve inherited through observation", async () => {
  const f = fixture(false, false, "Synthetic sentence. ".repeat(1800));
  const bound = budgetProducer(f, 24_000, { input_tokens: 32_001, output_tokens: 1 });
  try {
    const result = await runWritePass(f.db, f.vault, { ...f.options(), producer: bound.producer,
      extraction: { ...DEFAULT_EXTRACTION_CONFIG, max_input_tokens: 32_000 } });
    expect(result.errors).toContain("budget_exhausted");
    expect(bound.requests).toHaveLength(1);
    const estimate = Math.ceil(bound.requests[0]!.messages.reduce((sum, message) => sum + message.content.length, 0) / 4);
    expect(estimate + 24_000).toBeLessThanOrEqual(32_000);
    expect(JSON.stringify(bound.requests[0])).not.toContain("Synthetic sentence. ".repeat(1800));
    expect(readExtractCursor(f.db)).toBeNull();
    expect(bound.wire()).toBe(0);
  } finally { bound.cleanup(); f.close(); }
});

test("host prefix planner reserves overhead for the selected event prefix", async () => {
  const first = "First synthetic sentence. ".repeat(480), second = "Second synthetic sentence. ".repeat(480);
  const f = fixture(false, false, first);
  const bound = budgetProducer(f, 24_000, { input_tokens: 32_001, output_tokens: 1 });
  try {
    expect(accept(f.db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: "second-budget-record", text: second, subjects: [] },
      { source: { source_key: f.sourceKey, expected_revision: 1 } }).status).toBe("stored");
    const result = await runWritePass(f.db, f.vault, { ...f.options(), producer: bound.producer,
      extraction: { ...DEFAULT_EXTRACTION_CONFIG, max_input_tokens: 32_000 } });
    expect(result.errors).toContain("budget_exhausted");
    expect(bound.requests).toHaveLength(1);
    const request = bound.requests[0]!;
    const estimate = Math.ceil(request.messages.reduce((sum, message) => sum + message.content.length, 0) / 4);
    expect(estimate + 24_000).toBeLessThanOrEqual(32_000);
    expect(JSON.stringify(request)).toContain(first);
    expect(JSON.stringify(request)).not.toContain(second);
    expect(readExtractCursor(f.db)).toBeNull();
  } finally { bound.cleanup(); f.close(); }
});
