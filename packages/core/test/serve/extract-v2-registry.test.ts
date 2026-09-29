import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { bindSourceModelPort, setSourceGrant } from "../../src/ledger/source-grants";
import { readExtractCursor } from "../../src/serve/extract";
import { runWritePass } from "../../src/serve/write-pass";
import { ulid } from "../../src/util/ulid";
import { initVault } from "../../src/vault/init";
import { validEvent } from "../fixtures";

const roots: string[] = [];
const endpoint = "https://models.example.test/v1/chat/completions";
const model = "fixture-world-model";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Claim = readonly [predicate: string, object: { kind: "literal"; value: string } | { kind: "vocabulary"; ref: { kind: "vocabulary"; id: string } }];
const literal = (value: string) => ({ kind: "literal" as const, value });
const vocabulary = (id: string) => ({ kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id } });

/** One supplied subject, a scripted typed producer, and a real write pass. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "extract-v2-registry-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const sourceKey = ulid();
  registerConnection(db, "kizuki.fixture", sourceKey);
  setSourceGrant(db, {
    source_key: sourceKey, expected_revision: 0, operation_id: `grant-${sourceKey}`,
    policy: {
      purposes: ["capture", "recall", "derive", "extract"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: { model_endpoint: endpoint, model, external_retention: "provider_managed" }, sensitivity_floor: "public",
    },
  });
  let script: readonly Claim[] = [];
  const producer = bindSourceModelPort<ProducerV2Port>({
    descriptor: { id: "kizuki.producer.fixture-v2", kind: "producer", contract: PRODUCER_V2_CONTRACT, contract_minor: 0, supports: ["model"], requires_lease: false, optional_package: null },
    model_ref: model,
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => undefined,
    async produce(input: ProduceInputV2) {
      const anchor = { event_id: input.events[0]!.event_id, start_utf16: 0, end_utf16: 4 };
      return {
        status: "ok" as const,
        response: {
          schema: EXTRACT_RESPONSE_V2_SCHEMA,
          mentions: [],
          claims: script.map(([predicate, object], index) => ({
            id: `c${index}`, subject: { kind: "supplied" as const, id: "s0" }, predicate, object,
            perspective: { holder: null, speaker: null, addressee: null, mode: "asserted" as const, interpretation: "explicit" as const, anchors: [] },
            context: [], polarity: "positive" as const, body: `${predicate} of Flux.`, valid_from: null, valid_to: null,
            temporal_basis: "unknown" as const, confidence: 0.8, sensitivity: "public" as const, anchors: [anchor],
          })),
        },
        usage: { calls: 1, input_tokens: 20, output_tokens: 30 },
      };
    },
  }, { model_endpoint: endpoint, model });
  const record = (n: number) => {
    const accepted = accept(db, {
      ...validEvent(), connector_id: "kizuki.fixture", source_record_id: `record-${n}`, text: "Flux is a synthetic transformation.",
      subjects: [{ subject_id: "concept:flux", role: "about", display_name: "Flux" }],
    }, { source: { source_key: sourceKey, expected_revision: 1 } });
    if (accepted.status !== "stored") throw new Error("fixture capture failed");
  };
  return {
    db,
    record,
    pass: (claims: readonly Claim[]) => {
      script = claims;
      return runWritePass(db, vault, { producer, model_ref: model, claims: { db }, budget: createBudgetTracker({ canon_writes_per_run: 8 }) });
    },
    stored: () => db.query<{ predicate: string }, []>("SELECT predicate FROM claim_v2_semantics ORDER BY predicate").all().map(row => row.predicate),
    close: () => db.close(),
  };
}

test("a draft that contradicts its own batch is dropped, and the rest of the decision files", async () => {
  const f = fixture();
  try {
    f.record(1);
    const result = await f.pass([
      ["world.kind", vocabulary("world/concept")],
      ["concept.label", literal("Flux")],
      ["situation.objective", literal("Ship Flux")],
    ]);
    expect(result.errors).toEqual([]);
    expect(result.claims_extracted).toBe(2);
    expect(f.stored()).toEqual(["concept.label", "world.kind"]);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
    expect(readExtractCursor(f.db)).not.toBeNull();
  } finally { f.close(); }
});

test("a draft that contradicts an already stored classification is dropped instead of wedging the pass", async () => {
  const f = fixture();
  try {
    f.record(1);
    expect((await f.pass([["world.kind", vocabulary("world/situation")], ["situation.label", literal("Flux")]])).errors).toEqual([]);
    f.record(2);
    const result = await f.pass([["concept.definition", literal("A synthetic transformation.")], ["situation.objective", literal("Ship Flux")]]);
    expect(result.errors).toEqual([]);
    expect(result.claims_extracted).toBe(1);
    expect(f.stored()).toEqual(["situation.label", "situation.objective", "world.kind"]);
    expect(f.db.query("SELECT * FROM extract_batches").all()).toEqual([]);
  } finally { f.close(); }
});
