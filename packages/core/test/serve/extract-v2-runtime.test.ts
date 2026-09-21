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

function fixture(supplied = false) {
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
    text: "Flux is a synthetic transformation.",
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
      const anchor = { event_id: eventId, start_utf16: 0, end_utf16: 4 };
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
          mentions: supplied ? [] : [{ id: "m0", label: "Flux", anchor, candidate_refs: [] }],
          claims: [
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
