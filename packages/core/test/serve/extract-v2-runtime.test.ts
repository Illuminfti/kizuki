import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR } from "../../src/producer/model-v2";
import { modelProducerInputTokenOverhead } from "../../src/producer/fingerprint";
import { scriptedLlm, temporaryProducerContext } from "../producer/helpers";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { readRejections } from "../../src/serve/extract-rejections";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { runRail } from "../../src/serve/rails";
import { getRunReceipt, redactReceiptText } from "../../src/serve/receipts";
import { parseDurableWorldDrafts } from "../../src/serve/extract-v2";
import { mintOccurrenceId, type OccurrenceEventIdentity } from "../../src/claims/occurrences";
import { insertClaim } from "../../src/claims/store";
import type { WorldDraftInsert } from "../../src/producer/world-drafts";
import { canonicalJson } from "../../src/util/hash";
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

/** Two named ideas, each with its own definition, in one passage that an answer may anchor both on. */
const PASSAGE = "Flux and Grace: Flux is a synthetic transformation, Grace is a calm cadence.";

/**
 * `second` adds a second mention over the first one's span. "same label" names
 * the same thing again and repeats its classification in other words;
 * "another label" names a second idea and gives it a kind, label and definition.
 */
function fixture(supplied = false, role = false, text?: string, second?: "same label" | "another label") {
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
    text: text ?? (role ? "Ada joined the orchard library project." : second === "another label" ? PASSAGE : "Flux is a synthetic transformation."),
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
      const anchor = { event_id: eventId, start_utf16: 0, end_utf16: role ? 3 : second === "another label" ? PASSAGE.length : 4 };
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
          // A second mention over the same span resolves to the first one's occurrence subject.
          mentions: supplied ? [] : [{ id: "m0", label: role ? "Ada" : "Flux", anchor, candidate_refs: [] },
            ...(second === undefined ? [] : [{ id: "m1", label: second === "same label" ? "flux" : "Grace", anchor, candidate_refs: [] }])],
          claims: role ? [claim("role", "employment.role", { kind: "literal", value: "orchard library collaborator" }, "Ada is an orchard library collaborator.")] : [
            claim("c0", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }, "Flux is a concept."),
            claim("c1", "concept.label", { kind: "literal", value: "Flux" }, "The concept is called Flux."),
            claim("c2", "concept.definition", { kind: "literal", value: "A synthetic transformation." }, "Flux is a synthetic transformation."),
            // The second mention's classification is the first claim again, with other wording and another score.
            ...(second === undefined ? [] : [{ ...claim("c3", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } },
              second === "same label" ? "Flux, again, is a concept." : "Grace is a concept."), subject: { kind: "mention" as const, id: "m1" }, confidence: 0.6 }]),
            ...(second !== "another label" ? [] : [
              { ...claim("c4", "concept.label", { kind: "literal", value: "Grace" }, "The concept is called Grace."), subject: { kind: "mention" as const, id: "m1" } },
              { ...claim("c5", "concept.definition", { kind: "literal", value: "A calm cadence." }, "Grace is a calm cadence."), subject: { kind: "mention" as const, id: "m1" } },
            ]),
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

const worldClaims = (f: ReturnType<typeof fixture>) =>
  f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims WHERE is_world_typed=1").get()!.n;
const supports = (f: ReturnType<typeof fixture>) =>
  f.db.query<{ support_key: string; admission: string; admitted_at: string }, []>("SELECT support_key, admission, admitted_at FROM claim_v2_support ORDER BY support_key").all();
const renderings = (f: ReturnType<typeof fixture>) =>
  supports(f).map(row => (JSON.parse(row.admission) as { rendering: { body: string } }).rendering.body).sort();
/** Every name and definition filed on a concept, across all subjects. */
const conceptLiterals = (f: ReturnType<typeof fixture>, predicate: "concept.label" | "concept.definition") =>
  f.db.query<{ subject_id: string; value: string }, [string]>(
    "SELECT subject_id, json_extract(payload,'$.object.value') AS value FROM claim_v2_semantics WHERE predicate=? ORDER BY value").all(predicate);
function conceptsNamed(f: ReturnType<typeof fixture>, label: string): number {
  const found = readWorldView({ db: f.db, vaultPath: f.vault, principal: OWNER },
    { operation: "find_concepts", label, valid: { kind: "all" }, knownAt: { kind: "current" } });
  if ("status" in found || found.result.status === "unavailable" || !("matches" in found.result.data)) throw new Error("world discovery failed");
  return found.result.data.matches.length;
}
const journaledDrafts = (f: ReturnType<typeof fixture>) => parseDurableWorldDrafts(
  f.db.query<{ drafts: string }, []>("SELECT drafts FROM extract_batches").get()!.drafts, f.producer.model_ref);

/** Replaces the pending decision's drafts and signs the row again, as the build that journaled it would have. */
function rejournal(f: ReturnType<typeof fixture>, build: (drafts: readonly WorldDraftInsert[]) => readonly WorldDraftInsert[]) {
  const row = f.db.query<Record<string, string | null>, []>("SELECT * FROM extract_batches").get()!;
  const drafts = build(journaledDrafts(f));
  const digest = createHash("sha256").update("kizuki.extract-filing/atomic-v2\0").update(canonicalJson({
    decision_schema: "kizuki.extract-decision/v2", producer_contract: "kizuki.producer/v2", draft_schema: "kizuki.claim/v2",
    integrity_schema: "kizuki.extract-integrity/v2", previous_cursor: row.previous_cursor || null, cursor: row.cursor,
    model_ref: row.model_ref, input_ids: JSON.parse(row.input_ids!), mode: row.batch_mode,
    model_inputs: JSON.parse(row.model_inputs!), deferred_inputs: JSON.parse(row.deferred_inputs!), outcome: row.outcome, drafts,
  })).digest("hex");
  f.db.query("UPDATE extract_batches SET drafts=?,integrity=?").run(canonicalJson(drafts), `atomic-v2:${digest}`);
}

/** The same draft with another rendering and score and, when given, another literal or vocabulary value. */
function reworded(draft: WorldDraftInsert, body: string, object: WorldDraftInsert["semantic"]["object"] = draft.semantic.object): WorldDraftInsert {
  const semantic = { ...draft.semantic, object };
  return { ...draft, body, confidence: 0.3, semantic,
    world_admission: { ...draft.world_admission, semantic, confidence: 0.3, rendering: { body, frontmatter: {} } } };
}

/** The second mention's three drafts as a build that resolved both mentions to one subject journaled them. */
function secondMentionDrafts([kind, label, definition]: readonly WorldDraftInsert[]): WorldDraftInsert[] {
  return [reworded(kind!, "Grace is a concept."),
    reworded(label!, "The concept is called Grace.", { kind: "literal", value: "Grace" }),
    reworded(definition!, "Grace is a calm cadence.", { kind: "literal", value: "A calm cadence." })];
}

const TWICE = (f: ReturnType<typeof fixture>) => `claims refused: subject ${journaledDrafts(f)[0]!.semantic.subject.id.slice(0, 16)} is classified twice in one decision`;

test("two differently named mentions over one span file only the first: the second name and definition never reach its subject", async () => {
  const f = fixture(false, false, undefined, "another label");
  try {
    const result = await runWritePass(f.db, f.vault, f.options());
    expect(result.errors).toEqual([]);
    // The second mention's classification, label and definition are counted and dropped before the decision is journaled.
    expect(result.claims_rejected).toEqual({ invalid_claim: 3 });
    expect(result.claims_extracted).toBe(3);
    expect(result.claims_deduped).toBe(0);
    expect(worldClaims(f)).toBe(3);
    expect(renderings(f)).toEqual(["Flux is a concept.", "Flux is a synthetic transformation.", "The concept is called Flux."]);
    expect(conceptLiterals(f, "concept.label").map(row => row.value)).toEqual(["Flux"]);
    expect(conceptLiterals(f, "concept.definition").map(row => row.value)).toEqual(["A synthetic transformation."]);
    expect(conceptsNamed(f, "Flux")).toBe(1);
    expect(conceptsNamed(f, "Grace")).toBe(0);
    expect(JSON.stringify(discoverConcept(f))).not.toContain("Grace");
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).toContain(f.eventId);
  } finally { f.close(); }
});

test("a mention repeated under the same label classifies its subject once and keeps the first admission", async () => {
  const f = fixture(false, false, undefined, "same label");
  try {
    const result = await runWritePass(f.db, f.vault, f.options());
    expect(result.errors).toEqual([]);
    expect(result.claims_rejected).toEqual({});
    expect(result.claims_extracted).toBe(4);
    expect(result.claims_deduped).toBe(1);
    expect(worldClaims(f)).toBe(3);
    expect(renderings(f)).toEqual(["Flux is a concept.", "Flux is a synthetic transformation.", "The concept is called Flux."]);
    expect(new Set(supports(f).map(row => (JSON.parse(row.admission) as { confidence: number }).confidence)).size).toBe(1);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).toContain(f.eventId);
  } finally { f.close(); }
});

test("a decision an earlier build journaled with two mentions on one subject files the first and refuses the second with a receipt", async () => {
  const f = fixture(false, false, undefined, "another label");
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.producer), f.producer.model_ref, f.producer);
    // That build resolved both mentions to one subject and journaled all six claims on it.
    rejournal(f, drafts => [...drafts, ...secondMentionDrafts(drafts)]);
    const drafts = journaledDrafts(f);
    expect(drafts).toHaveLength(6);
    expect(new Set(drafts.map(draft => JSON.stringify(draft.semantic.subject))).size).toBe(1);
    expect(drafts[3]!.semantic).toEqual(drafts[0]!.semantic);
    expect(drafts[3]!.world_admission.rendering).not.toEqual(drafts[0]!.world_admission.rendering);
    const line = TWICE(f);
    f.reopen();
    const hooks = { model_ref: f.producer.model_ref, claims: { db: f.db }, producer: f.producer };
    const receipt = getRunReceipt(f.db, (await runRail(f.db, f.vault, "sync", { hooks })).run_id)!;
    expect(receipt.status).toBe("degraded");
    expect(receipt.stopped).toBeNull();
    expect(receipt.errors).toEqual([line]);
    expect(redactReceiptText(line)).toBe(line);
    expect(receipt.claims_rejected).toEqual({ subject_classified_twice: 3 });
    expect(receipt.model.calls).toBe(0);
    expect(f.calls.count).toBe(1);
    expect(worldClaims(f)).toBe(3);
    expect(renderings(f)).toEqual(["Flux is a concept.", "Flux is a synthetic transformation.", "The concept is called Flux."]);
    expect(conceptLiterals(f, "concept.label").map(row => row.value)).toEqual(["Flux"]);
    expect(conceptLiterals(f, "concept.definition").map(row => row.value)).toEqual(["A synthetic transformation."]);
    expect(conceptsNamed(f, "Grace")).toBe(0);
    // The decision is complete: the rail moves on and the next pass has nothing to refuse.
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).toContain(f.eventId);
    const settled = supports(f);
    const next = getRunReceipt(f.db, (await runRail(f.db, f.vault, "sync", { hooks })).run_id)!;
    expect(next.errors).toEqual([]);
    expect(next.claims_rejected).toEqual({});
    expect(supports(f)).toEqual(settled);
  } finally { f.close(); }
});

test("in such a journal nothing naming the subject files after its second classification, whatever the order", async () => {
  const f = fixture(false, false, undefined, "another label");
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.producer), f.producer.model_ref, f.producer);
    rejournal(f, drafts => {
      const [kind, label, definition] = secondMentionDrafts(drafts);
      // A claim about another subject that names this one as its object is held to the same rule.
      const elsewhere = { event_id: f.eventId, start_utf16: 9, end_utf16: 14 };
      const event = f.db.query<Omit<OccurrenceEventIdentity, "event_id">, [string]>(
        "SELECT connector_id,source_record_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at FROM events WHERE event_id=?").get(f.eventId)!;
      const semantic = { ...drafts[0]!.semantic, predicate: "concept.requires", anchors: [...drafts[0]!.semantic.anchors, elsewhere],
        subject: { kind: "occurrence" as const, id: mintOccurrenceId({ ...event, event_id: f.eventId }, f.sourceKey, elsewhere) },
        object: { kind: "subject" as const, ref: drafts[0]!.semantic.subject } };
      const requires = { ...drafts[0]!, body: "Grace requires it.", semantic,
        world_admission: { ...drafts[0]!.world_admission, semantic, rendering: { body: "Grace requires it.", frontmatter: {} } } };
      return [drafts[0]!, drafts[1]!, kind!, drafts[2]!, label!, definition!, requires];
    });
    const result = await runWritePass(f.db, f.vault, f.options());
    expect(result.claims_rejected).toEqual({ subject_classified_twice: 5 });
    expect(renderings(f)).toEqual(["Flux is a concept.", "The concept is called Flux."]);
    expect(conceptLiterals(f, "concept.label").map(row => row.value)).toEqual(["Flux"]);
    expect(conceptLiterals(f, "concept.definition")).toEqual([]);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
  } finally { f.close(); }
});

test("a decision replayed over an admission another filing stored in other words adds nothing and keeps that admission", async () => {
  const f = fixture();
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.producer), f.producer.model_ref, f.producer);
    const drafts = journaledDrafts(f);
    f.db.exec("CREATE TEMP TABLE held_batch AS SELECT * FROM extract_batches; DELETE FROM extract_batches;");
    expect((await insertClaim({ db: f.db }, reworded(drafts[0]!, "Flux names a concept."))).outcome).toBe("stored");
    f.db.exec("INSERT INTO extract_batches SELECT * FROM held_batch; DROP TABLE held_batch;");
    const [first] = supports(f);
    // Core clamps a model's score to 0.5, so only a lower one is another score once stored.
    expect(JSON.parse(first!.admission)).toMatchObject({ confidence: 0.3, rendering: { body: "Flux names a concept." } });
    f.reopen();
    const replay = await runWritePass(f.db, f.vault, f.options());
    expect(replay.errors).toEqual([]);
    expect(replay.claims_rejected).toEqual({});
    expect(replay.model.calls).toBe(0);
    expect(replay.claims_deduped).toBe(1);
    expect(f.calls.count).toBe(1);
    expect(worldClaims(f)).toBe(3);
    // The earlier admission is the stored one, byte for byte, with its own time.
    expect(supports(f)).toHaveLength(3);
    expect(supports(f)).toContainEqual(first!);
    expect(renderings(f)).toEqual(["Flux is a synthetic transformation.", "Flux names a concept.", "The concept is called Flux."]);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).toContain(f.eventId);
    // Nothing is left to replay: the next pass makes no change to the admissions.
    const settled = supports(f);
    expect((await runWritePass(f.db, f.vault, f.options())).errors).toEqual([]);
    expect(supports(f)).toEqual(settled);
  } finally { f.close(); }
});

/**
 * Journals the fixture decision, then admits one of its drafts first under another assessment.
 * With `pending` false the decision is dropped again, so the next pass mines it afresh.
 */
async function conflictingDecision(f: ReturnType<typeof fixture>, index: number, pending = true) {
  const mined = await mineLiveDrafts(f.db, f.producer);
  journalExtractBatch(f.db, mined, f.producer.model_ref, f.producer);
  const drafts = journaledDrafts(f);
  f.db.exec("CREATE TEMP TABLE held_batch AS SELECT * FROM extract_batches; DELETE FROM extract_batches;");
  expect((await insertClaim({ db: f.db }, drafts[index]!)).outcome).toBe("stored");
  if (pending) f.db.exec("INSERT INTO extract_batches SELECT * FROM held_batch;");
  f.db.exec("DROP TABLE held_batch;");
  const row = f.db.query<{ support_key: string; admission: string }, []>("SELECT support_key, admission FROM claim_v2_support").get()!;
  const admission = JSON.stringify({ ...JSON.parse(row.admission), epistemicKind: "observed" });
  f.db.query("UPDATE claim_v2_support SET admission=? WHERE support_key=?").run(admission, row.support_key);
  return { support_key: row.support_key, admission,
    line: `claim refused: support ${row.support_key.slice(0, 16)} conflicts with immutable admission (epistemicKind)` };
}

test("a genuine admission conflict refuses that draft with a receipt and files the rest", async () => {
  const f = fixture();
  try {
    const conflict = await conflictingDecision(f, 2);
    const hooks = { model_ref: f.producer.model_ref, claims: { db: f.db }, producer: f.producer };
    const receipt = getRunReceipt(f.db, (await runRail(f.db, f.vault, "sync", { hooks })).run_id)!;
    // The persisted receipt names the stored row by a key prefix redaction keeps, and only field names.
    expect(receipt.status).toBe("degraded");
    expect(receipt.stopped).toBeNull();
    expect(receipt.errors).toEqual([conflict.line]);
    expect(redactReceiptText(conflict.line)).toBe(conflict.line);
    expect(receipt.claims_rejected).toEqual({ support_admission_conflict: 1 });
    expect(receipt.model.calls).toBe(0);
    expect(f.calls.count).toBe(1);
    expect(worldClaims(f)).toBe(3);
    expect(supports(f)).toHaveLength(3);
    // The immutable row is untouched, and the decision no longer holds the rail.
    expect(f.db.query<{ admission: string }, [string]>("SELECT admission FROM claim_v2_support WHERE support_key=?").get(conflict.support_key)!.admission).toBe(conflict.admission);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).toContain(f.eventId);
    const next = getRunReceipt(f.db, (await runRail(f.db, f.vault, "sync", { hooks })).run_id)!;
    expect(next.errors).toEqual([]);
    expect(next.claims_rejected).toEqual({});
  } finally { f.close(); }
});

test("a conflict met in the pass that mined the decision is refused with the same receipt", async () => {
  const f = fixture();
  try {
    const conflict = await conflictingDecision(f, 2, false);
    const hooks = { model_ref: f.producer.model_ref, claims: { db: f.db }, producer: f.producer };
    const receipt = getRunReceipt(f.db, (await runRail(f.db, f.vault, "sync", { hooks })).run_id)!;
    expect(f.calls.count).toBe(2);
    expect(receipt.model.calls).toBe(1);
    expect(receipt.status).toBe("degraded");
    expect(receipt.errors).toEqual([conflict.line]);
    expect(receipt.claims_rejected).toEqual({ support_admission_conflict: 1 });
    expect(worldClaims(f)).toBe(3);
    expect(f.db.query<{ admission: string }, [string]>("SELECT admission FROM claim_v2_support WHERE support_key=?").get(conflict.support_key)!.admission).toBe(conflict.admission);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).toContain(f.eventId);
  } finally { f.close(); }
});

test("a refused draft commits with the rest of its decision or not at all", async () => {
  const f = fixture();
  try {
    const conflict = await conflictingDecision(f, 0);
    // The first draft is refused, the second files, and the third is interrupted.
    f.db.exec(`CREATE TRIGGER fail_second_support BEFORE INSERT ON claim_v2_support
      WHEN (SELECT count(*) FROM claim_v2_support) >= 2 BEGIN SELECT RAISE(ABORT,'atomic interruption'); END`);
    await expect(runWritePass(f.db, f.vault, f.options())).rejects.toThrow("atomic interruption");
    expect(worldClaims(f)).toBe(1);
    expect(supports(f)).toHaveLength(1);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 1 });
    expect(readExtractCursor(f.db)).toBeNull();
    f.db.exec("DROP TRIGGER fail_second_support");
    f.reopen();
    const replay = await runWritePass(f.db, f.vault, f.options());
    expect(replay.errors).toEqual([conflict.line]);
    expect(replay.claims_rejected).toEqual({ support_admission_conflict: 1 });
    expect(f.calls.count).toBe(1);
    expect(worldClaims(f)).toBe(3);
    expect(f.db.query<{ admission: string }, [string]>("SELECT admission FROM claim_v2_support WHERE support_key=?").get(conflict.support_key)!.admission).toBe(conflict.admission);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).toContain(f.eventId);
  } finally { f.close(); }
});

test("a refused draft leaves no claim behind even when it wrote before the conflict", async () => {
  const f = fixture();
  try {
    const conflict = await conflictingDecision(f, 2);
    // A ledger that lost the meaning row makes the draft store a new claim before it meets the support.
    f.db.exec("DELETE FROM claim_v2_semantics");
    const result = await runWritePass(f.db, f.vault, f.options());
    // The damaged claim also fails its own canon write; only the refusal matters here.
    expect(result.errors).toContain(conflict.line);
    expect(result.claims_rejected).toEqual({ support_admission_conflict: 1 });
    expect(worldClaims(f)).toBe(3);
    expect(f.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM claims c WHERE is_world_typed=1
      AND NOT EXISTS (SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id)`).get()).toEqual({ n: 0 });
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claim_v2_semantics").get()).toEqual({ n: 2 });
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
  } finally { f.close(); }
});

test("any other writer refusal still holds the whole decision: only the two permanent refusals are per draft", async () => {
  const f = fixture();
  try {
    journalExtractBatch(f.db, await mineLiveDrafts(f.db, f.producer), f.producer.model_ref, f.producer);
    // A journal whose last draft contradicts the kind its first one files: the writer refuses it only once that one is stored.
    rejournal(f, drafts => [...drafts, reworded(drafts[0]!, "Flux is a situation.", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } })]);
    for (let pass = 0; pass < 2; pass++) {
      await expect(runWritePass(f.db, f.vault, f.options())).rejects.toThrow("world_endpoint_kind");
      expect(worldClaims(f)).toBe(0);
      expect(supports(f)).toEqual([]);
      expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM extract_batches").get()).toEqual({ n: 1 });
      expect(readExtractCursor(f.db)).toBeNull();
    }
    expect(f.calls.count).toBe(1);
  } finally { f.close(); }
});
