import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { ClaimDraft, ProduceInput, ProduceResult, ProducerPort } from "../src/contracts/producer";
import type { SourceModelEgress } from "../src/ledger/source-grants";
import { MODEL_PRODUCER_DESCRIPTOR } from "../src/producer";
import { accept } from "../src/ledger/ledger";
import { insertClaim, listClaims } from "../src/claims/store";
import { createBudgetTracker } from "../src/canon/budget";
import { openLedger } from "../src/ledger/db";
import { registerConnection } from "../src/ledger/connections";
import {
  bindSourceModelPort,
  inspectSourceGrant,
  revokeSourceGrant,
  setSourceGrant,
} from "../src/ledger/source-grants";
import {
  completeDurableExtractBatch,
  commitExtractCursor,
  journalExtractBatch,
  mineLiveDrafts,
  readDurableExtractBatch,
  readExtractCursor,
} from "../src/serve/extract";
import { initVault } from "../src/vault/init";
import { validEvent } from "./fixtures";
import { ulid } from "../src/util/ulid";
import { exportVault, restoreVault, verifyBackup, type ExportManifest } from "../src/export";
import { purgeEvents } from "../src/ledger/purge";
import { runWritePass } from "../src/serve/write-pass";
import { commitMachineByteIntent } from "../src/ledger/event-origin";
import { sha256Hex } from "../src/util/hash";

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

function durableIntegrity(row: {
  previous_cursor: string;
  cursor: string;
  model_ref: string | null;
  input_ids: string;
  batch_mode: string;
  model_inputs: string;
  deferred_inputs: string;
  outcome: string;
  drafts: string;
}): string {
  const drafts = JSON.parse(row.drafts) as ClaimDraft[];
  return createHash("sha256").update(JSON.stringify([
    row.previous_cursor || null,
    row.cursor,
    row.model_ref,
    JSON.parse(row.input_ids),
    row.batch_mode,
    JSON.parse(row.model_inputs),
    JSON.parse(row.deferred_inputs),
    row.outcome,
    drafts.map(item => [
      item.kind,
      item.subject,
      item.predicate,
      item.object,
      item.polarity,
      item.body,
      item.valid_from,
      item.valid_to,
      item.confidence,
      item.sensitivity,
      item.event_ids,
    ]),
  ])).digest("hex");
}

function legacyDurableIntegrity(row: {
  previous_cursor: string;
  cursor: string;
  model_ref: string | null;
  input_ids: string;
  outcome: string;
  drafts: string;
}): string {
  const drafts = JSON.parse(row.drafts) as ClaimDraft[];
  return createHash("sha256").update(JSON.stringify([
    row.previous_cursor || null,
    row.cursor,
    row.model_ref,
    JSON.parse(row.input_ids),
    row.outcome,
    drafts.map(item => [
      item.kind, item.subject, item.predicate, item.object, item.polarity,
      item.body, item.valid_from, item.valid_to, item.confidence,
      item.sensitivity, item.event_ids,
    ]),
  ])).digest("hex");
}

function resignBackupFile(backup: string, relativePath: string, contents: string): void {
  const file = join(backup, relativePath);
  writeFileSync(file, contents, { mode: 0o600 });
  chmodSync(file, 0o600);
  const manifestPath = join(backup, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExportManifest;
  manifest.files[relativePath] = {
    count: contents.length === 0 ? 0 : contents.split("\n").filter(Boolean).length,
    sha256: new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex"),
    size: Buffer.byteLength(contents),
    mode: 0o600,
  };
  const { manifest_sha256: _old, ...unsigned } = manifest;
  manifest.manifest_sha256 = new Bun.CryptoHasher("sha256")
    .update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
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
        expect(mined.mined.status).toBe(binding === null ? "unavailable" : "deferred");
        expect(mined.cursor === null).toBe(binding === null);
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
      expect(() => readDurableExtractBatch(reopened, mismatch)).toThrow("durable extraction authorization is pending");
    } finally { reopened.close(); }
  });
});

test("review: mixed denied history remains eligible after a grant change", async () => {
 const {db,source:first}=setup(); const second=ulid(); registerConnection(db,"kizuki.fixture",second);
 try {
  grant(db,first); grant(db,second,"local_only","review-grant-second");
  capture(db,first,"allowed-first"); const prior=capture(db,second,"withheld-later");
  const seen:string[]=[];
  const bound=bindSourceModelPort(producer({status:"ok",claims:[],usage:{calls:1,input_tokens:1,output_tokens:1}}, input=>{seen.push(...input.events.map(e=>e.event_id));}),{model_endpoint:endpoint,model:"fixture-model"});
  const firstResult=await mineLiveDrafts(db,bound); expect(commitExtractCursor(db,firstResult)).toBe(true);
  expect(seen).not.toContain(prior.event_id);
  setSourceGrant(db,{source_key:second,expected_revision:1,operation_id:"review-grant-expansion",policy:policy()});
  await mineLiveDrafts(db,bound);
  expect(seen).toContain(prior.event_id);
 } finally {db.close();}
});
test("review: one denied source cannot block a later permitted source forever", async () => {
 const {db,source:first}=setup(); const second=ulid(); registerConnection(db,"kizuki.fixture",second);
 try {
  grant(db,first,"local_only"); grant(db,second,remoteEgress(),"review-grant-second");
  for(let i=0;i<8;i++) capture(db,first,"denied-"+i);
  const allowed=capture(db,second,"allowed-after-denied-page"), seen:string[]=[];
  const bound=bindSourceModelPort(producer({status:"ok",claims:[],usage:{calls:1,input_tokens:1,output_tokens:1}}, input=>{seen.push(...input.events.map(e=>e.event_id));}),{model_endpoint:endpoint,model:"fixture-model"});
  for(let i=0;i<3;i++){const mined=await mineLiveDrafts(db,bound); commitExtractCursor(db,mined);}
  expect(seen).toContain(allowed.event_id);
 } finally {db.close();}
});

test("more than two denied pages cannot starve a later authorized event", async () => {
  const { db, source: deniedSource } = setup();
  const allowedSource = ulid();
  registerConnection(db, "kizuki.fixture", allowedSource);
  try {
    grant(db, deniedSource, "local_only");
    grant(db, allowedSource, remoteEgress(), "grant-later-source");
    for (let index = 0; index < 17; index++) capture(db, deniedSource, `held-${index}`);
    const allowed = capture(db, allowedSource, "after-seventeen-held");
    const seen: string[] = [];
    const bound = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } },
      input => seen.push(...input.events.map(event => event.event_id))), { model_endpoint: endpoint, model: "fixture-model" });
    for (let pass = 0; pass < 6 && !seen.includes(allowed.event_id); pass++) {
      const mined = await mineLiveDrafts(db, bound);
      if (mined.mined.status === "empty" || mined.mined.status === "deferred") commitExtractCursor(db, mined);
    }
    expect(seen).toContain(allowed.event_id);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM extract_deferred_inputs").get()!.n).toBe(17);
  } finally { db.close(); }
});

test("a frontier journal binds a later authorized input without filing the earlier denied input", async () => {
  const { vault, db, source: deniedSource } = setup();
  const allowedSource = ulid();
  registerConnection(db, "kizuki.fixture", allowedSource);
  try {
    grant(db, deniedSource, "local_only");
    grant(db, allowedSource, remoteEgress(), "grant-journal-source");
    const denied = capture(db, deniedSource, "held-before-authorized");
    const allowed = capture(db, allowedSource, "authorized-after-held");
    const seen: string[] = [];
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(allowed.event_id)],
      usage: { calls: 1, input_tokens: 2, output_tokens: 2 },
    }, input => seen.push(...input.events.map(event => event.event_id))), {
      model_endpoint: endpoint,
      model: "fixture-model",
    });
    const result = await runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "fixture-model-ref",
      claims: { db },
      producer: bound,
    });
    expect(seen).toEqual([allowed.event_id]);
    expect(result.claims_extracted).toBe(1);
    expect(listClaims(db, { status: "live", limit: 20 }).filter(claim => claim.producer === "model")).toHaveLength(1);
    expect(db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(denied.event_id)).not.toBeNull();
    expect(db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(allowed.event_id)).toBeNull();
  } finally { db.close(); }
});

test("a frontier journal cannot omit one deferred member with a recomputed digest", async () => {
  const { db, source: allowedSource } = setup();
  const deniedSource = ulid();
  registerConnection(db, "kizuki.fixture", deniedSource);
  try {
    grant(db, allowedSource);
    grant(db, deniedSource, "local_only", "grant-denied-partition");
    const allowed = capture(db, allowedSource, "partition-allowed");
    const denied = capture(db, deniedSource, "partition-denied");
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(allowed.event_id)],
      usage: { calls: 1, input_tokens: 2, output_tokens: 1 },
    }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    expect(mined.deferred_inputs?.map(item => item.event_id)).toEqual([denied.event_id]);
    journalExtractBatch(db, mined, "fixture-partition-model", bound);
    const row = db.query<{
      previous_cursor: string;
      cursor: string;
      model_ref: string | null;
      input_ids: string;
      batch_mode: string;
      model_inputs: string;
      deferred_inputs: string;
      outcome: string;
      drafts: string;
    }, []>("SELECT * FROM extract_batches").get()!;
    row.deferred_inputs = "[]";
    db.query("UPDATE extract_batches SET deferred_inputs=?,integrity=?")
      .run(row.deferred_inputs, durableIntegrity(row));
    expect(() => readDurableExtractBatch(db, bound)).toThrow("durable extraction input partition is corrupt");
  } finally { db.close(); }
});

test("a permission-preserving grant revision replays the durable decision without another model call", async () => {
  const { vault, db, source } = setup();
  try {
    grant(db, source);
    const event = capture(db, source, "durable-permission-expansion");
    let calls = 0;
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(event.event_id)],
      usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }, () => { calls += 1; }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    journalExtractBatch(db, mined, "fixture-original-model-ref", bound);
    setSourceGrant(db, {
      source_key: source,
      expected_revision: 1,
      operation_id: "expand-durable-permission",
      policy: { ...policy(), purposes: [...policy().purposes, "audit"] },
    });
    const replay = readDurableExtractBatch(db, bound)!;
    expect(replay.model_inputs[0]?.checked_revision).toBe(1);
    expect(replay.model_inputs[0]?.checked_binding_digest).toBe(mined.model_inputs?.[0]?.checked_binding_digest);
    const result = await runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 0 }),
      model_ref: "fixture-current-model-ref",
      claims: { db },
      producer: bound,
    });
    expect(result.errors).toEqual([]);
    expect(calls).toBe(1);
    expect(listClaims(db, { status: "live", limit: 20 })).toHaveLength(1);
    expect(listClaims(db, { status: "live", limit: 20 })[0]?.model_ref).toBe("fixture-original-model-ref");
    expect(db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
  } finally { db.close(); }
});

test("a narrowed grant keeps the durable decision pending without another model call", async () => {
  const { vault, db, source } = setup();
  try {
    grant(db, source);
    const event = capture(db, source, "durable-permission-narrow");
    let calls = 0;
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(event.event_id)],
      usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }, () => { calls += 1; }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    journalExtractBatch(db, mined, "fixture-original-model-ref", bound);
    setSourceGrant(db, {
      source_key: source,
      expected_revision: 1,
      operation_id: "narrow-durable-permission",
      policy: { ...policy(), purposes: policy().purposes.filter(item => item !== "extract") },
    });
    expect(() => readDurableExtractBatch(db, bound)).toThrow("durable extraction authorization is pending");
    const blocked = await runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 0 }),
      model_ref: "fixture-current-model-ref",
      claims: { db },
      producer: bound,
    });
    expect(blocked.stopped).toBe("source:durable_extraction_authorization_pending");
    expect(blocked.errors).toEqual([]);
    expect(blocked.model).toEqual({ calls: 0, input_tokens: 0, output_tokens: 0, unavailable: 0, wall_ms: 0 });
    expect(calls).toBe(1);
    expect(db.query("SELECT 1 FROM extract_batches").get()).not.toBeNull();
    expect(readExtractCursor(db)).toBeNull();
    setSourceGrant(db, {
      source_key: source,
      expected_revision: 2,
      operation_id: "restore-durable-permission",
      policy: policy(),
    });
    const resumed = await runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 0 }),
      model_ref: "fixture-current-model-ref",
      claims: { db },
      producer: bound,
    });
    expect(resumed.errors).toEqual([]);
    expect(calls).toBe(1);
    expect(listClaims(db, { status: "live", limit: 20 })[0]?.model_ref).toBe("fixture-original-model-ref");
    expect(db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
    expect(readExtractCursor(db)).not.toBeNull();
  } finally { db.close(); }
});

test("a grant change after replay authorization cannot complete that filing attempt", async () => {
  const { vault, db, source } = setup();
  try {
    grant(db, source);
    const event = capture(db, source, "durable-attempt-epoch");
    let calls = 0;
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(event.event_id)],
      usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }, () => { calls += 1; }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    journalExtractBatch(db, mined, "fixture-original-model-ref", bound);
    const authorized = readDurableExtractBatch(db, bound)!;
    setSourceGrant(db, {
      source_key: source,
      expected_revision: 1,
      operation_id: "expand-during-filing-attempt",
      policy: { ...policy(), purposes: [...policy().purposes, "audit"] },
    });
    expect(() => completeDurableExtractBatch(db, authorized, bound))
      .toThrow("durable extraction authorization is pending");
    expect(db.query("SELECT 1 FROM extract_batches").get()).not.toBeNull();
    expect(readExtractCursor(db)).toBeNull();
    const resumed = await runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 0 }),
      model_ref: "fixture-current-model-ref",
      claims: { db },
      producer: bound,
    });
    expect(resumed.errors).toEqual([]);
    expect(calls).toBe(1);
    expect(listClaims(db, { status: "live", limit: 20 })[0]?.model_ref).toBe("fixture-original-model-ref");
    expect(db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
  } finally { db.close(); }
});

test("a configured destination change reconsiders deferred input without a grant revision", async () => {
  const { db, source } = setup();
  try {
    grant(db, source);
    const event = capture(db, source, "binding-change");
    const wrong = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }),
      { model_endpoint: "https://other.example.test/v1/chat/completions", model: "fixture-model" });
    const deferred = await mineLiveDrafts(db, wrong);
    expect(deferred.mined.status).toBe("deferred");
    expect(commitExtractCursor(db, deferred)).toBe(true);
    let seen: string[] = [];
    const exact = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } },
      input => { seen = input.events.map(item => item.event_id); }), { model_endpoint: endpoint, model: "fixture-model" });
    const replay = await mineLiveDrafts(db, exact);
    expect(seen).toEqual([event.event_id]);
    expect(commitExtractCursor(db, replay)).toBe(true);
    expect(db.query("SELECT 1 FROM extract_deferred_inputs").get()).toBeNull();
  } finally { db.close(); }
});

test("a deferred journal refuses when its exact sent input is no longer queued", async () => {
  const { db, source } = setup();
  try {
    const event = await captureAfterWrongGrant(db, source);
    setSourceGrant(db, {
      source_key: source,
      expected_revision: 1,
      operation_id: "authorize-deferred-journal",
      policy: policy(),
    });
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(event.event_id)],
      usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    expect(mined.mode).toBe("deferred");
    journalExtractBatch(db, mined, "fixture-deferred-model", bound);
    db.query("DELETE FROM extract_deferred_inputs WHERE event_id=?").run(event.event_id);
    expect(() => readDurableExtractBatch(db, bound))
      .toThrow("durable extraction input partition is corrupt");
    expect(readExtractCursor(db)).not.toBeNull();
  } finally { db.close(); }
});

test("a managed journal cannot be downgraded to the null legacy manifest", async () => {
  const { db, source } = setup();
  try {
    grant(db, source);
    const held = ulid();
    registerConnection(db, "kizuki.fixture", held);
    grant(db, held, "local_only", "grant-held-for-downgrade");
    const allowed = capture(db, source, "managed-downgrade-allowed");
    capture(db, held, "managed-downgrade-held");
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(allowed.event_id)],
      usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    journalExtractBatch(db, mined, "fixture-managed-model", bound);
    const row = db.query<any, []>("SELECT * FROM extract_batches").get()!;
    db.query("UPDATE extract_batches SET model_inputs=NULL,deferred_inputs=NULL,integrity=?")
      .run(legacyDurableIntegrity(row));
    expect(() => readDurableExtractBatch(db, bound))
      .toThrow("durable extraction legacy input authority is corrupt");
    expect(readExtractCursor(db)).toBeNull();
    expect(db.query("SELECT 1 FROM extract_batches").get()).not.toBeNull();
  } finally { db.close(); }
});

test("an unbound historical null-manifest journal replays without a provider resend", async () => {
  const { vault, db, source } = setup();
  try {
    const accepted = accept(db, { ...validEvent(), source_record_id: "historical-unbound" });
    if (accepted.status !== "stored") throw new Error("historical fixture capture failed");
    let calls = 0;
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(accepted.event.event_id)],
      usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }, () => { calls += 1; }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    journalExtractBatch(db, mined, "historical-model-ref", bound);
    db.query("UPDATE extract_batches SET model_inputs=NULL,deferred_inputs=NULL,input_ids=NULL,integrity=NULL").run();

    db.query("INSERT INTO native_owner_evidence(event_id,origin,request_digest,recorded_at,filing_state,event_content_hash) VALUES (?,'correction',?,?,'recorded',?)")
      .run(accepted.event.event_id, "a".repeat(64), new Date().toISOString(), accepted.event.content_hash);
    expect(() => readDurableExtractBatch(db, bound))
      .toThrow("durable extraction legacy input authority is corrupt");
    db.query("DELETE FROM native_owner_evidence WHERE event_id=?").run(accepted.event.event_id);

    // A later, unrelated grant changes the global epoch. It cannot relabel the
    // historical input or cause the already-sent decision to be regenerated.
    grant(db, source, remoteEgress(), "unrelated-later-grant");
    const pending = readDurableExtractBatch(db, bound)!;
    expect(pending.model_ref).toBe("historical-model-ref");
    const replayAuthorization = pending.historical_source_write;
    if (replayAuthorization === undefined) throw new Error("historical replay authorization missing");
    expect(db.query<{ model_inputs: string | null; deferred_inputs: string | null; input_ids: string | null; integrity: string | null }, []>(
      "SELECT model_inputs,deferred_inputs,input_ids,integrity FROM extract_batches",
    ).get()).toMatchObject({ model_inputs: null, deferred_inputs: null });
    expect(db.query<{ input_ids: string | null; integrity: string | null }, []>(
      "SELECT input_ids,integrity FROM extract_batches",
    ).get()).toMatchObject({ input_ids: expect.any(String), integrity: expect.any(String) });
    await expect(insertClaim({ db, historical_source_write: replayAuthorization }, {
      kind: "claim",
      subject: "person:fixture",
      predicate: "employment.role",
      object: "fixture role",
      polarity: "positive",
      body: "Different text must not reuse the replay capability.",
      valid_from: accepted.event.observed_at,
      provenance: [accepted.event.event_id],
      subjects: ["person:fixture"],
      producer: "model",
      model_ref: "historical-model-ref",
      confidence: 0.7,
      taint: "quoted",
      sensitivity: "private",
    })).rejects.toThrow("source_access_denied");
    await expect(insertClaim({ db, historical_source_write: replayAuthorization }, {
      kind: "claim",
      subject: "person:fixture",
      predicate: "employment.role",
      object: "fixture role",
      polarity: "positive",
      body: "Synthetic model interpretation.",
      provenance: [accepted.event.event_id],
      valid_from: "2099-01-01T00:00:00Z",
      subjects: ["person:fixture"],
      producer: "model",
      model_ref: "historical-model-ref",
      confidence: 0.7,
      taint: "quoted",
      sensitivity: "private",
    })).rejects.toThrow("source_access_denied");
    let changedEpoch = false;
    await expect(insertClaim({
      db,
      historical_source_write: replayAuthorization,
      now: () => {
        if (!changedEpoch) {
          changedEpoch = true;
          setSourceGrant(db, {
            source_key: source,
            expected_revision: 1,
            operation_id: "change-epoch-during-legacy-filing",
            policy: { ...policy(), purposes: [...policy().purposes, "audit"] },
          });
        }
        return new Date().toISOString();
      },
    }, {
      kind: "claim",
      subject: "person:fixture",
      predicate: "employment.role",
      object: "fixture role",
      polarity: "positive",
      body: "Synthetic model interpretation.",
      provenance: [accepted.event.event_id],
      valid_from: accepted.event.observed_at,
      subjects: ["person:fixture"],
      producer: "model",
      model_ref: "historical-model-ref",
      confidence: 0.7,
      taint: "quoted",
      sensitivity: "private",
    })).rejects.toThrow("source_access_denied");
    expect(changedEpoch).toBe(true);
    expect(listClaims(db, { status: "live", limit: 20 }).filter(claim => claim.producer === "model")).toEqual([]);

    const replayed = await runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "current-model-ref",
      claims: { db },
      producer: bound,
    });
    expect(replayed.errors).toEqual([]);
    expect(calls).toBe(1);
    expect(listClaims(db, { status: "live", limit: 20 }).filter(claim => claim.producer === "model"))
      .toMatchObject([{ model_ref: "historical-model-ref" }]);
    expect(db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
  } finally { db.close(); }
});

test("a historical null-manifest draft cannot cite outside its authoritative interval", async () => {
  const { db } = setup();
  try {
    const inside = accept(db, { ...validEvent(), source_record_id: "legacy-inside" });
    if (inside.status !== "stored") throw new Error("legacy inside fixture failed");
    const bound = bindSourceModelPort(producer({
      status: "ok", claims: [draft(inside.event.event_id)], usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }), { model_endpoint: endpoint, model: "fixture-model" });
    journalExtractBatch(db, await mineLiveDrafts(db, bound), "historical-provenance-model", bound);
    const outside = accept(db, { ...validEvent(), source_record_id: "legacy-outside" });
    if (outside.status !== "stored") throw new Error("legacy outside fixture failed");
    const row = db.query<any, []>("SELECT * FROM extract_batches").get()!;
    row.drafts = JSON.stringify([draft(outside.event.event_id)]);
    db.query("UPDATE extract_batches SET drafts=?,model_inputs=NULL,deferred_inputs=NULL,integrity=?")
      .run(row.drafts, legacyDurableIntegrity(row));
    expect(() => readDurableExtractBatch(db, bound)).toThrow("durable extraction provenance is invalid");
    expect(readExtractCursor(db)).toBeNull();
  } finally { db.close(); }
});

test("purge keeps a surviving historical journal in its null-manifest form", async () => {
  const { vault, db } = setup();
  try {
    const first = accept(db, { ...validEvent(), source_record_id: "legacy-purge-first" });
    const second = accept(db, { ...validEvent(), source_record_id: "legacy-purge-second" });
    if (first.status !== "stored" || second.status !== "stored") throw new Error("legacy purge fixture failed");
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(first.event.event_id)],
      usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    journalExtractBatch(db, mined, "historical-purge-model", bound);
    const row = db.query<any, []>("SELECT * FROM extract_batches").get()!;
    db.query("UPDATE extract_batches SET model_inputs=NULL,deferred_inputs=NULL,integrity=?")
      .run(legacyDurableIntegrity(row));
    purgeEvents(db, vault, { event_id: second.event.event_id }, "remove second historical input");
    expect(db.query("SELECT model_inputs,deferred_inputs,outcome FROM extract_batches").get())
      .toEqual({ model_inputs: null, deferred_inputs: null, outcome: "purged" });
    expect(readDurableExtractBatch(db, bound)?.drafts).toEqual([draft(first.event.event_id)]);
  } finally { db.close(); }
});

test("managed pending origin filtering preserves the saved decision, external claims, and deferred membership", async () => {
  const { vault, db, source } = setup();
  try {
    const held = ulid();
    registerConnection(db, "kizuki.fixture", held);
    grant(db, source);
    grant(db, held, "local_only", "grant-origin-held");
    const first = capture(db, source, "origin-first");
    const laterSelf = capture(db, source, "origin-later-self");
    const last = capture(db, source, "origin-last");
    const deferred = capture(db, held, "origin-held");
    const alreadySelf = accept(db, { ...validEvent(), connector_id: "kizuki.fixture", source_record_id: "origin-already-self",
      text: "KIZUKI CONTEXT v1 bounded managed source" }, { source: { source_key: source, expected_revision: 1 } });
    if (alreadySelf.status !== "stored") throw new Error("fixture failed");
    let calls = 0;
    let sent: string[] = [];
    const drafts = [
      { ...draft(first.event_id), subject: "person:first", body: "First external interpretation." },
      { ...draft(laterSelf.event_id), subject: "person:self", body: "Mixed origin interpretation.", event_ids: [first.event_id, laterSelf.event_id] },
      { ...draft(last.event_id), subject: "person:last", body: "Last external interpretation." },
    ];
    const bound = bindSourceModelPort(producer({ status: "ok", claims: drafts,
      usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }, input => {
      calls += 1; sent = input.events.map(event => event.event_id);
    }), { model_endpoint: endpoint, model: "fixture-model" });
    const options = { budget: createBudgetTracker({ canon_writes_per_run: 8 }), model_ref: "original-origin-model",
      claims: { db }, producer: bound };
    db.exec("CREATE TRIGGER interrupt_origin BEFORE INSERT ON claims WHEN NEW.subject='person:self' BEGIN SELECT RAISE(ABORT,'synthetic origin interruption'); END");
    await expect(runWritePass(db, vault, options)).rejects.toThrow("synthetic origin interruption");
    db.exec("DROP TRIGGER interrupt_origin");
    const original = db.query<Record<string, unknown>, []>("SELECT * FROM extract_batches").get()!;
    expect(listClaims(db, { status: "live", limit: 20 }).find(claim => claim.subject === "person:first")).toBeUndefined();
    expect(calls).toBe(1);
    expect(sent).toEqual([first.event_id, laterSelf.event_id, last.event_id]);
    commitMachineByteIntent(db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(laterSelf.text) }, () => undefined);
    const pending = readDurableExtractBatch(db, bound)!;
    expect(pending.drafts).toEqual(drafts);
    expect(pending.filing_drafts).toEqual([drafts[0]!, drafts[2]!]);
    expect(pending.model_inputs.map(input => input.event_id)).toEqual(sent);
    expect(pending.deferred_inputs.map(input => input.event_id)).toEqual([deferred.event_id]);
    expect(db.query("SELECT * FROM extract_batches").get()).toEqual(original);
    const result = await runWritePass(db, vault, { ...options, model_ref: "changed-current-model" });
    expect(result.errors).toEqual([]);
    expect(calls).toBe(1);
    const claims = listClaims(db, { status: "live", limit: 20 }).filter(claim => claim.producer === "model");
    expect(claims.map(claim => claim.subject).sort()).toEqual(["person:first", "person:last"]);
    expect(claims.filter(claim => claim.subject === "person:first")).toHaveLength(1);
    expect(claims.every(claim => claim.model_ref === "original-origin-model")).toBe(true);
    expect(readExtractCursor(db)).toContain(alreadySelf.event.event_id);
    expect(db.query("SELECT * FROM extract_batches").get()).toBeNull();
    expect(db.query<{ event_id: string }, []>("SELECT event_id FROM extract_deferred_inputs").all())
      .toEqual([{ event_id: deferred.event_id }]);
  } finally { db.close(); }
});

test("backup restores an exact pending mixed-permission decision without another model call", async () => {
  const { vault, db, source } = setup();
  const held = ulid();
  registerConnection(db, "kizuki.fixture", held);
  grant(db, source);
  grant(db, held, "local_only", "grant-backup-held");
  const allowed = capture(db, source, "backup-pending-allowed");
  const deferred = capture(db, held, "backup-pending-held");
  let calls = 0;
  const original = bindSourceModelPort(producer({
    status: "ok",
    claims: [draft(allowed.event_id)],
    usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
  }, () => { calls += 1; }), { model_endpoint: endpoint, model: "fixture-model" });
  const mined = await mineLiveDrafts(db, original);
  journalExtractBatch(db, mined, "backup-original-model", original);
  expect(calls).toBe(1);

  const backup = `${vault}-pending-backup`;
  const target = `${vault}-pending-restored`;
  dirs.push(backup, target);
  exportVault(db, vault, backup);
  expect(verifyBackup(backup).files["serve/extract-batches.jsonl"]?.count).toBe(1);
  restoreVault(backup, target);
  db.close();

  const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
  try {
    let replayCalls = 0;
    const replayPort = bindSourceModelPort(producer({
      status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }, () => { replayCalls += 1; }), { model_endpoint: endpoint, model: "fixture-model" });
    const result = await runWritePass(restored, target, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "different-current-model",
      claims: { db: restored },
      producer: replayPort,
    });
    expect(result.errors).toEqual([]);
    expect(replayCalls).toBe(0);
    expect(listClaims(restored, { status: "live", limit: 20 }).filter(claim => claim.producer === "model"))
      .toMatchObject([{ body: "Synthetic model interpretation.", model_ref: "backup-original-model" }]);
    expect(restored.query("SELECT 1 FROM extract_batches").get()).toBeNull();
    expect(restored.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(deferred.event_id)).not.toBeNull();
    purgeEvents(restored, target, { event_id: deferred.event_id }, "remove deferred restored source");
    expect(restored.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(deferred.event_id)).toBeNull();
  } finally { restored.close(); }
});

test("backup retains and replays the null representation of a historical journal", async () => {
  const { vault, db, source } = setup();
  const accepted = accept(db, { ...validEvent(), source_record_id: "legacy-backup-input" });
  if (accepted.status !== "stored") throw new Error("legacy backup fixture failed");
  let calls = 0;
  const original = bindSourceModelPort(producer({
    status: "ok", claims: [draft(accepted.event.event_id)], usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
  }, () => { calls += 1; }), { model_endpoint: endpoint, model: "fixture-model" });
  journalExtractBatch(db, await mineLiveDrafts(db, original), "legacy-backup-model", original);
  db.query("UPDATE extract_batches SET model_inputs=NULL,deferred_inputs=NULL,input_ids=NULL,integrity=NULL").run();
  grant(db, source, remoteEgress(), "unrelated-export-grant");

  const backup = `${vault}-legacy-pending-backup`;
  const target = `${vault}-legacy-pending-restored`;
  dirs.push(backup, target);
  try {
    exportVault(db, vault, backup);
    restoreVault(backup, target);
  } finally { db.close(); }
  const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
  try {
    expect(restored.query("SELECT model_inputs,deferred_inputs FROM extract_batches").get())
      .toEqual({ model_inputs: null, deferred_inputs: null });
    let replayCalls = 0;
    const replay = bindSourceModelPort(producer({
      status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }, () => { replayCalls += 1; }), { model_endpoint: endpoint, model: "fixture-model" });
    await runWritePass(restored, target, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "current-model",
      claims: { db: restored },
      producer: replay,
    });
    expect(calls).toBe(1);
    expect(replayCalls).toBe(0);
    expect(listClaims(restored, { status: "live", limit: 20 }).filter(claim => claim.producer === "model"))
      .toMatchObject([{ model_ref: "legacy-backup-model" }]);
  } finally { restored.close(); }
});

test("restore refuses a malformed or missing required durable journal stream transactionally", async () => {
  const { vault, db, source } = setup();
  try {
    grant(db, source);
    const event = capture(db, source, "backup-invalid-journal");
    const bound = bindSourceModelPort(producer({
      status: "ok", claims: [draft(event.event_id)], usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }), { model_endpoint: endpoint, model: "fixture-model" });
    journalExtractBatch(db, await mineLiveDrafts(db, bound), "backup-invalid-model", bound);

    const malformed = `${vault}-malformed-journal`;
    const malformedTarget = `${vault}-malformed-target`;
    const missing = `${vault}-missing-journal`;
    dirs.push(malformed, malformedTarget, missing);
    exportVault(db, vault, malformed);
    const path = "serve/extract-batches.jsonl";
    const row = JSON.parse(readFileSync(join(malformed, path), "utf8")) as Record<string, unknown>;
    row.deferred_inputs = null;
    resignBackupFile(malformed, path, `${JSON.stringify(row)}\n`);
    expect(() => restoreVault(malformed, malformedTarget)).toThrow("durable extraction batch is corrupt");
    expect(existsSync(malformedTarget)).toBe(false);

    exportVault(db, vault, missing);
    const manifestPath = join(missing, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExportManifest;
    delete manifest.files[path];
    const { manifest_sha256: _old, ...unsigned } = manifest;
    manifest.manifest_sha256 = new Bun.CryptoHasher("sha256")
      .update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    unlinkSync(join(missing, path));
    expect(() => verifyBackup(missing)).toThrow("backup durable extraction stream is missing");
  } finally { db.close(); }
});

test("restore explicitly reports the recovery limit of a pre-v8 backup", () => {
  const { vault, db } = setup();
  const backup = `${vault}-legacy-backup`;
  const target = `${vault}-legacy-restored`;
  dirs.push(backup, target);
  try {
    exportVault(db, vault, backup);
    const manifestPath = join(backup, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExportManifest;
    for (const path of ["serve/extract-deferred-inputs.jsonl", "serve/extract-batches.jsonl"]) {
      delete manifest.files[path];
      unlinkSync(join(backup, path));
    }
    manifest.schema_versions.serve = 7;
    const { manifest_sha256: _old, ...unsigned } = manifest;
    manifest.manifest_sha256 = new Bun.CryptoHasher("sha256")
      .update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const report = restoreVault(backup, target);
    expect(report.recovery_warnings).toEqual([
      "backup predates durable extraction recovery; an interrupted model decision was not preserved",
    ]);
  } finally { db.close(); }
});

test("deferred input survives restart and backup while required-stream omission refuses", async () => {
  const { vault, db, source } = setup();
  const event = await captureAfterWrongGrant(db, source);
  db.close();
  const reopened = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const backup = `${vault}-backup`;
  const target = `${vault}-restored`;
  const omitted = `${vault}-omitted`;
  dirs.push(backup, target, omitted);
  try {
    exportVault(reopened, vault, backup);
    expect(verifyBackup(backup).files["serve/extract-deferred-inputs.jsonl"]?.count).toBe(1);
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      setSourceGrant(restored, { source_key: source, expected_revision: 1, operation_id: "grant-after-restore", policy: policy() });
      let seen: string[] = [];
      const exact = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } },
        input => { seen = input.events.map(item => item.event_id); }), { model_endpoint: endpoint, model: "fixture-model" });
      expect((await mineLiveDrafts(restored, exact)).mined.status).toBe("empty");
      expect(seen).toEqual([event.event_id]);
    } finally { restored.close(); }
    exportVault(reopened, vault, omitted);
    const manifestPath = join(omitted, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & { files: Record<string, unknown> };
    delete manifest.files["serve/extract-deferred-inputs.jsonl"];
    const { manifest_sha256: _old, ...unsigned } = manifest;
    manifest.manifest_sha256 = new Bun.CryptoHasher("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    unlinkSync(join(omitted, "serve", "extract-deferred-inputs.jsonl"));
    expect(() => verifyBackup(omitted)).toThrow("backup deferred extraction stream is missing");
  } finally { reopened.close(); }
});

test("purge removes deferred metadata without retaining event payload", async () => {
  const { vault, db, source } = setup();
  try {
    const event = await captureAfterWrongGrant(db, source);
    expect(db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(event.event_id)).not.toBeNull();
    db.exec("CREATE TRIGGER fail_deferred_purge BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => purgeEvents(db, vault, { event_id: event.event_id }, "owner source cleanup")).toThrow("injected");
    expect(db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(event.event_id)).not.toBeNull();
    db.exec("DROP TRIGGER fail_deferred_purge");
    purgeEvents(db, vault, { event_id: event.event_id }, "owner source cleanup");
    expect(db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(event.event_id)).toBeNull();
    expect(JSON.stringify(db.query("SELECT * FROM extract_invalidations").all())).not.toContain("Synthetic");
  } finally { db.close(); }
});

test("partial deferred filing replays one decision without duplicate claims or writes", async () => {
  const { vault, db, source } = setup();
  try {
    const event = await captureAfterWrongGrant(db, source);
    setSourceGrant(db, { source_key: source, expected_revision: 1, operation_id: "authorize-deferred-filing", policy: policy() });
    let calls = 0;
    const bound = bindSourceModelPort(producer({ status: "ok", claims: [
      draft(event.event_id),
      { ...draft(event.event_id), subject: "person:second", object: "second fixture role", body: "Second synthetic model interpretation." },
    ], usage: { calls: 1, input_tokens: 2, output_tokens: 2 } }, () => { calls += 1; }),
    { model_endpoint: endpoint, model: "fixture-model" });
    const options = { budget: createBudgetTracker({ canon_writes_per_run: 8 }), model_ref: "fixture-model-ref", claims: { db }, producer: bound };
    db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON claims WHEN NEW.subject='person:second' BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(runWritePass(db, vault, options)).rejects.toThrow("injected");
    db.exec("DROP TRIGGER fail_second");
    await runWritePass(db, vault, options);
    expect(calls).toBe(1);
    expect(listClaims(db, { status: "live", limit: 20 }).filter(claim => claim.producer === "model")).toHaveLength(2);
    expect(db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
    expect(db.query("SELECT 1 FROM extract_deferred_inputs").get()).toBeNull();
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_receipts WHERE writer='loop'").get()!.n).toBe(2);
  } finally { db.close(); }
});

test("a denied-only pass records deferred work with honest zero-model metrics", async () => {
  const { vault, db, source } = setup();
  try {
    grant(db, source, "local_only");
    capture(db, source, "metadata-only");
    let calls = 0;
    const bound = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }, () => { calls += 1; }),
      { model_endpoint: endpoint, model: "fixture-model" });
    const result = await runWritePass(db, vault, { budget: createBudgetTracker({ canon_writes_per_run: 8 }), model_ref: "fixture-model-ref", claims: { db }, producer: bound });
    expect(calls).toBe(0);
    expect(result.model).toEqual({ calls: 0, input_tokens: 0, output_tokens: 0, unavailable: 0, wall_ms: 0 });
    expect(result.stopped).toBeNull();
    expect(result.errors).toEqual([]);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM extract_deferred_inputs").get()!.n).toBe(1);
    expect(readExtractCursor(db)).not.toBeNull();
  } finally { db.close(); }
});

test("binding and unrelated grant changes never replay accepted frontier history", async () => {
  const { db, source } = setup();
  const unrelated = ulid();
  registerConnection(db, "kizuki.fixture", unrelated);
  try {
    grant(db, source);
    capture(db, source, "accepted-once");
    let calls = 0;
    const exact = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }, () => { calls += 1; }),
      { model_endpoint: endpoint, model: "fixture-model" });
    const first = await mineLiveDrafts(db, exact);
    expect(commitExtractCursor(db, first)).toBe(true);
    expect(calls).toBe(1);
    grant(db, unrelated, "local_only", "unrelated-grant");
    expect((await mineLiveDrafts(db, exact)).mined.status).toBe("empty");
    expect(calls).toBe(1);
    let changedCalls = 0;
    const changed = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }, () => { changedCalls += 1; }),
      { model_endpoint: "https://other.example.test/v1/chat/completions", model: "fixture-model" });
    expect((await mineLiveDrafts(db, changed)).mined.status).toBe("empty");
    expect(changedCalls).toBe(0);
  } finally { db.close(); }
});

test("deferred scan uses bounded primary-key range plans", () => {
  const { db } = setup();
  try {
    const range = db.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT event_id FROM extract_deferred_inputs WHERE event_id>'01M1R000000000000000000000' ORDER BY event_id LIMIT 8").all();
    const wrap = db.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT event_id FROM extract_deferred_inputs ORDER BY event_id LIMIT 8").all();
    expect(range.map(row => row.detail).join(" ")).toContain("event_id>?");
    expect(wrap.map(row => row.detail).join(" ")).toContain("sqlite_autoindex_extract_deferred_inputs_1");
  } finally { db.close(); }
});

test("malformed deferred metadata fails closed without moving the frontier", async () => {
  const { db, source } = setup();
  try {
    await captureAfterWrongGrant(db, source);
    const before = readExtractCursor(db);
    db.exec("UPDATE extract_deferred_inputs SET checked_binding_digest='not-a-digest'");
    const bound = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }),
      { model_endpoint: endpoint, model: "fixture-model" });
    await expect(mineLiveDrafts(db, bound)).rejects.toThrow("deferred extraction metadata is corrupt");
    expect(readExtractCursor(db)).toBe(before);
  } finally { db.close(); }
});

test("malformed and oversized durable input manifests fail closed", async () => {
  const { db, source } = setup();
  try {
    grant(db, source);
    const event = capture(db, source, "journal-manifest");
    const bound = bindSourceModelPort(producer({
      status: "ok",
      claims: [draft(event.event_id)],
      usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
    }), { model_endpoint: endpoint, model: "fixture-model" });
    const mined = await mineLiveDrafts(db, bound);
    journalExtractBatch(db, mined, "fixture-model-ref", bound);
    const original = db.query<{ model_inputs: string }, []>("SELECT model_inputs FROM extract_batches").get()!.model_inputs;
    db.query("UPDATE extract_batches SET model_inputs=?").run("not-json");
    expect(() => readDurableExtractBatch(db, bound)).toThrow("durable extraction model inputs is corrupt");
    const oversized = Array.from({ length: 9 }, () => ({
      event_id: ulid(),
      source_key: null,
      checked_revision: 0,
      checked_binding_digest: "0".repeat(64),
    }));
    db.query("UPDATE extract_batches SET model_inputs=?").run(JSON.stringify(oversized));
    expect(() => readDurableExtractBatch(db, bound)).toThrow("durable extraction model inputs is corrupt");
    db.query("UPDATE extract_batches SET model_inputs=NULL").run();
    expect(() => readDurableExtractBatch(db, bound)).toThrow("durable extraction batch is corrupt");
    db.query("UPDATE extract_batches SET model_inputs=?").run(original);
    expect(readDurableExtractBatch(db, bound)?.input_ids).toEqual([event.event_id]);
  } finally { db.close(); }
});

function captureAfterWrongGrant(db: Database, source: string) {
  grant(db, source, "local_only");
  const event = capture(db, source, "durable-deferred");
  const wrong = bindSourceModelPort(producer({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }),
    { model_endpoint: endpoint, model: "fixture-model" });
  return mineLiveDrafts(db, wrong).then(mined => {
    expect(mined.mined.status).toBe("deferred");
    expect(commitExtractCursor(db, mined)).toBe(true);
    return event;
  });
}
