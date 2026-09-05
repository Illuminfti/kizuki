import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  commitExtractCursor,
  journalExtractBatch,
  mineLiveDrafts,
  readDurableExtractBatch,
  readExtractCursor,
} from "../src/serve/extract";
import { initVault } from "../src/vault/init";
import { validEvent } from "./fixtures";
import { ulid } from "../src/util/ulid";
import { exportVault, restoreVault, verifyBackup } from "../src/export";
import { purgeEvents } from "../src/ledger/purge";
import { runWritePass } from "../src/serve/write-pass";

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
      expect(() => readDurableExtractBatch(reopened, mismatch)).toThrow("source_access_denied");
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
