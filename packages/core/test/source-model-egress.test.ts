import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { ClaimDraft, ProduceInput, ProduceResult, ProducerPort } from "../src/contracts/producer";
import type { SourceModelEgress } from "../src/ledger/source-grants";
import { MODEL_PRODUCER_DESCRIPTOR } from "../src/producer";
import { accept } from "../src/ledger/ledger";
import { insertClaim } from "../src/claims/store";
import { openLedger } from "../src/ledger/db";
import { registerConnection } from "../src/ledger/connections";
import {
  bindSourceModelPort,
  inspectSourceGrant,
  revokeSourceGrant,
  setSourceGrant,
} from "../src/ledger/source-grants";
import {
  journalExtractBatch,
  mineLiveDrafts,
  readDurableExtractBatch,
  readExtractCursor,
} from "../src/serve/extract";
import { initVault } from "../src/vault/init";
import { validEvent } from "./fixtures";
import { ulid } from "../src/util/ulid";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const endpoint = "https://models.example.test/v1/chat/completions";
const remoteEgress = (overrides: Record<string, unknown> = {}): SourceModelEgress => ({
  model_endpoint: endpoint,
  model: "fixture-model",
  external_retention: "provider_managed",
  ...overrides,
});
const policy = (egress: unknown = remoteEgress()) => ({
  purposes: ["capture", "recall", "derive", "extract", "export"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked",
  egress,
  sensitivity_floor: "private",
});

function setup() {
  const vault = mkdtempSync(join(tmpdir(), "source-model-egress-"));
  dirs.push(vault);
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const source = ulid();
  registerConnection(db, "kizuki.fixture", source);
  return { vault, db, source };
}

function grant(db: Database, source: string, egress: unknown = remoteEgress(), operation = "grant-model") {
  return setSourceGrant(db, {
    source_key: source,
    expected_revision: 0,
    operation_id: operation,
    policy: policy(egress),
  });
}

function capture(db: Database, source: string, suffix = "one") {
  const result = accept(db, {
    ...validEvent(),
    connector_id: "kizuki.fixture",
    source_record_id: suffix,
    text: `Synthetic ${suffix} source evidence.`,
  }, { source: { source_key: source, expected_revision: 1 } });
  if (result.status !== "stored") throw new Error("fixture capture failed");
  return result.event;
}

function producer(result: ProduceResult, onInput?: (input: ProduceInput) => void): ProducerPort {
  return {
    descriptor: MODEL_PRODUCER_DESCRIPTOR,
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => {},
    produce: async input => { onInput?.(input); return result; },
  };
}

function draft(eventId: string): ClaimDraft {
  return {
    kind: "claim",
    subject: "person:fixture",
    predicate: "employment.role",
    object: "fixture role",
    polarity: "positive",
    body: "Synthetic model interpretation.",
    valid_from: null,
    valid_to: null,
    confidence: 0.7,
    sensitivity: "private",
    event_ids: [eventId],
  };
}

describe("source model egress policy", () => {
  test("canonical destination consent is durable and exact operation replay survives restart", () => {
    const { vault, db, source } = setup();
    const raw = remoteEgress({ model_endpoint: "https://MODELS.example.test:443/v1/chat/completions" });
    const receipt = grant(db, source, raw);
    expect(inspectSourceGrant(db, source)?.policy.egress).toEqual(remoteEgress());
    expect(setSourceGrant(db, {
      source_key: source,
      expected_revision: 0,
      operation_id: "grant-model",
      policy: policy(remoteEgress()),
    })).toEqual(receipt);
    expect(() => setSourceGrant(db, {
      source_key: source,
      expected_revision: 0,
      operation_id: "grant-model",
      policy: policy(remoteEgress({ model: "other-model" })),
    })).toThrow("operation_conflict");
    const local = ulid();
    registerConnection(db, "kizuki.fixture", local);
    const localReceipt = grant(db, local, "local_only", "grant-local-digest");
    expect(localReceipt.policy_digest).toBe("12e2706ad835afc20bfc0c600e3d202a3ecdea1f0c516782abe941420aae5ad6");
    db.close();
    const reopened = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try { expect(inspectSourceGrant(reopened, source)?.policy.egress).toEqual(remoteEgress()); }
    finally { reopened.close(); }
  });

  test("malformed or widened destinations refuse without retaining supplied text", () => {
    const invalid = [
      remoteEgress({ model_endpoint: "http://models.example.test/v1/chat/completions" }),
      remoteEgress({ model_endpoint: "https://user:secret@models.example.test/v1/chat/completions" }),
      remoteEgress({ model_endpoint: `${endpoint}?tenant=private` }),
      remoteEgress({ model_endpoint: `${endpoint}#private` }),
      remoteEgress({ model_endpoint: " https://models.example.test/v1/chat/completions" }),
      remoteEgress({ model_endpoint: "https://models.example.test/v1/%0a/chat/completions" }),
      remoteEgress({ model_endpoint: `https://models.example.test/${"x".repeat(2_100)}` }),
      remoteEgress({ model: "private model" }),
      remoteEgress({ model: `m${"x".repeat(256)}` }),
      remoteEgress({ external_retention: "kizuki_managed" }),
    ];
    for (const [index, egress] of invalid.entries()) {
      const { db, source } = setup();
      try {
        let failure: unknown;
        try { grant(db, source, egress, `invalid-${index}`); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).not.toContain("secret");
        expect(inspectSourceGrant(db, source)).toBeNull();
      } finally { db.close(); }
    }
  });
});

describe("source model egress authority", () => {
  test("only the exact host-bound model receives an authorized event", async () => {
    const { db, source } = setup();
    try {
      grant(db, source);
      const event = capture(db, source);
      const ok = { status: "ok" as const, claims: [draft(event.event_id)], usage: { calls: 1, input_tokens: 2, output_tokens: 1 } };
      for (const binding of [null, { model_endpoint: endpoint, model: "other-model" }, { model_endpoint: "https://other.example.test/v1/chat/completions", model: "fixture-model" }]) {
        let calls = 0;
        const candidate = producer(ok, () => { calls++; });
        if (binding !== null) bindSourceModelPort(candidate, binding);
        const mined = await mineLiveDrafts(db, candidate);
        expect(mined.mined.status).toBe("unavailable");
        expect(mined.cursor).toBeNull();
        expect(calls).toBe(0);
      }
      let input: ProduceInput | null = null;
      const allowed = bindSourceModelPort(producer(ok, value => { input = value; }), { model_endpoint: endpoint, model: "fixture-model" });
      const mined = await mineLiveDrafts(db, allowed);
      expect(mined.mined).toEqual({ status: "ok", count: 1 });
      expect(input).not.toBeNull();
      expect((input as unknown as ProduceInput).events.map(item => item.event_id)).toEqual([event.event_id]);
    } finally { db.close(); }
  });

  test("mixed sources and known claims never cross a destination grant", async () => {
    const { db, source: first } = setup();
    const second = ulid();
    registerConnection(db, "kizuki.fixture", second);
    try {
      grant(db, first);
      grant(db, second, remoteEgress({ model_endpoint: "https://other.example.test/v1/chat/completions" }), "grant-second");
      const allowedEvent = capture(db, first, "allowed");
      const withheldEvent = capture(db, second, "withheld");
      await insertClaim({ db }, {
        kind: "claim",
        subject: "person:ada",
        predicate: "employment.role",
        object: "withheld prior role",
        body: "Withheld prior interpretation.",
        provenance: [withheldEvent.event_id],
        producer: "deterministic",
        confidence: 0.8,
        sensitivity: "private",
        taint: "quoted",
      });
      let seen: ProduceInput | null = null;
      const bound = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }, input => { seen = input; }), { model_endpoint: endpoint, model: "fixture-model" });
      const mined = await mineLiveDrafts(db, bound);
      expect(mined.mined.status).toBe("empty");
      expect(seen).not.toBeNull();
      expect((seen as unknown as ProduceInput).events.map(item => item.event_id)).toEqual([allowedEvent.event_id]);
      expect((seen as unknown as ProduceInput).context.known_claims).toEqual([]);
    } finally { db.close(); }
  });

  test("revocation during the call discards output and cannot advance the cursor", async () => {
    const { db, source } = setup();
    try {
      grant(db, source);
      const event = capture(db, source);
      let calls = 0;
      const bound = bindSourceModelPort(producer({ status: "ok", claims: [draft(event.event_id)], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }, () => {
        calls++;
        revokeSourceGrant(db, { source_key: source, expected_revision: 1, operation_id: "revoke-during-model" });
      }), { model_endpoint: endpoint, model: "fixture-model" });
      const mined = await mineLiveDrafts(db, bound);
      expect(calls).toBe(1);
      expect(mined.mined.status).toBe("unavailable");
      expect(mined.cursor).toBeNull();
      expect(readExtractCursor(db)).toBeNull();
    } finally { db.close(); }
  });

  test("a grant revision during the call discards output and cannot advance the cursor", async () => {
    const { db, source } = setup();
    try {
      grant(db, source);
      const event = capture(db, source);
      const bound = bindSourceModelPort(producer({ status: "ok", claims: [draft(event.event_id)], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }, () => {
        setSourceGrant(db, {
          source_key: source,
          expected_revision: 1,
          operation_id: "narrow-during-model",
          policy: policy("local_only"),
        });
      }), { model_endpoint: endpoint, model: "fixture-model" });
      const mined = await mineLiveDrafts(db, bound);
      expect(mined.mined.status).toBe("unavailable");
      expect(mined.cursor).toBeNull();
      expect(readExtractCursor(db)).toBeNull();
      expect(inspectSourceGrant(db, source)?.revision).toBe(2);
    } finally { db.close(); }
  });

  test("a bounded provider failure remains unavailable and leaves no checkpoint", async () => {
    const { db, source } = setup();
    try {
      grant(db, source);
      capture(db, source);
      const bound = bindSourceModelPort(producer({ status: "unavailable", reason: "provider unavailable", usage: { calls: 1, input_tokens: 0, output_tokens: 0 } }), { model_endpoint: endpoint, model: "fixture-model" });
      expect((await mineLiveDrafts(db, bound)).mined.status).toBe("unavailable");
      expect(readExtractCursor(db)).toBeNull();
    } finally { db.close(); }
  });

  test("a durable decision reopens only with a currently authorized bound destination", async () => {
    const { vault, db, source } = setup();
    grant(db, source);
    const event = capture(db, source);
    const bound = bindSourceModelPort(producer({ status: "ok", claims: [draft(event.event_id)], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    journalExtractBatch(db, mined, "fixture-ref", bound);
    db.close();
    const reopened = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try {
      const restarted = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 } }), { model_endpoint: endpoint, model: "fixture-model" });
      expect(readDurableExtractBatch(reopened, restarted)?.input_ids).toEqual([event.event_id]);
      const mismatch = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 } }), { model_endpoint: "https://other.example.test/v1/chat/completions", model: "fixture-model" });
      expect(() => readDurableExtractBatch(reopened, mismatch)).toThrow("source_access_denied");
    } finally { reopened.close(); }
  });
});
