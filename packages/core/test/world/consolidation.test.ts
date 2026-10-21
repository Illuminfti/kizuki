import { writeRailCursor } from "../../src/ledger/checkpoints";
import { expect, test, setDefaultTimeout } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { bindSourceModelPort, inspectSourceGrant, setSourceGrant, sourceEventsAllowed } from "../../src/ledger/source-grants";
import type { LlmPort, LlmRequest } from "../../src/contracts/llm";
import type { ConceptCard } from "../../src/contracts/concept-card";
import { runWorldJobs } from "../../src/serve/world-jobs";
import { readWorldView } from "../../src/serving/world-view";
import { worldSeed, type WorldSeed } from "../helpers/world-seed";

const MODEL = "synthetic-consolidation";
const ENDPOINT = "https://fixture.invalid/v1/chat/completions";
const SUMMARY = "Bayesian updating revises beliefs using evidence.";

function card(seed: WorldSeed): ConceptCard {
  const discovery = readWorldView(seed.ctx, { operation: "find_concepts", label: seed.label,
    valid: { kind: "all" }, knownAt: { kind: "current" } });
  if (!("result" in discovery) || discovery.result.status === "unavailable" || !("matches" in discovery.result.data))
    throw new Error("synthetic Concept discovery unavailable");
  const ref = discovery.result.data.matches[0]?.ref;
  if (ref === undefined) throw new Error("synthetic Concept absent");
  const read = readWorldView(seed.ctx, { operation: "concept", concept: ref,
    valid: { kind: "all" }, knownAt: { kind: "current" } });
  if (!("result" in read) || read.result.status === "unavailable" || read.result.data.schema !== "kizuki.concept-card/v1")
    throw new Error("synthetic Concept card unavailable");
  return read.result.data;
}

function model(db: ReturnType<typeof openLedger>, options: { reply?: string; outputTokens?: number; onCall?: () => void | Promise<void> } = {}) {
  const requests: LlmRequest[] = [];
  const llm: LlmPort = {
    descriptor: { id: "synthetic.llm", kind: "llm", contract: "kizuki.llm/v1", contract_minor: 0,
      supports: ["chat"], requires_lease: false, optional_package: null },
    model_ref: `synthetic.llm:${MODEL}@fixture.invalid`,
    health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    async complete(request) {
      expect(db.inTransaction).toBe(false);
      requests.push(request);
      await options.onCall?.();
      return { text: options.reply ?? JSON.stringify({ schema: "kizuki.consolidation-response/v1", status: "complete", summary: SUMMARY }),
        model: MODEL, usage: { input_tokens: 40, output_tokens: options.outputTokens ?? 16 } };
    },
  };
  bindSourceModelPort(llm, { model_endpoint: ENDPOINT, model: MODEL });
  return { llm, requests };
}

function authorizeModel(seed: WorldSeed) {
  // Claims were already admitted by worldSeed: model extraction is complete.
  const at = seed.ctx.db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(seed.eventId)!.accepted_at;
  writeRailCursor(seed.ctx.db, "kizuki.producer.model", "extract", `${at}\t${seed.eventId}`);
  const grant = inspectSourceGrant(seed.ctx.db, seed.sourceKey)!;
  setSourceGrant(seed.ctx.db, { source_key: seed.sourceKey, expected_revision: grant.revision,
    operation_id: `consolidation-${seed.sourceKey}`, policy: { ...grant.policy,
      purposes: [...grant.policy.purposes, "extract"],
      egress: { model_endpoint: ENDPOINT, model: MODEL, external_retention: "provider_managed" },
    } });
}

const job = (seed: WorldSeed, llm?: LlmPort) => ({
  db: seed.ctx.db, vaultPath: seed.ctx.vaultPath, now: () => new Date().toISOString(),
  stopRequested: () => false, modelConfigured: llm !== undefined, ...(llm === undefined ? {} : { llm }),
});

test("an eligible Concept without consolidation stays explicit about pending summary work", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db);
    await runWorldJobs(job(seed));
    const read = card(seed);
    expect(read.definitions).toHaveLength(1);
    expect(read.summary).toBeNull();
    expect(read.coverage.gaps).toContain("pending_consolidation");
  } finally { db.close(); }
});

test("the registered consolidation job serves its model text with exact current admission references", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db);
    authorizeModel(seed);
    expect(sourceEventsAllowed(db, [seed.eventId], { owner: true, model: true, purpose: "extract", port: bound.llm })).toBe(true);
    expect((await runWorldJobs(job(seed, bound.llm))).errors).toEqual([]);
    expect(bound.requests).toHaveLength(1);
    const read = card(seed);
    expect(read.summary?.text).toBe(SUMMARY);
    expect(read.summary?.admissions.length).toBeGreaterThan(0);
    expect(read.coverage.gaps).not.toContain("pending_consolidation");
  } finally { db.close(); }
});

test("local-only evidence makes no consolidation model call and stays pending", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db);
    expect(sourceEventsAllowed(db, [seed.eventId], { owner: true, model: true, purpose: "extract", port: bound.llm })).toBe(false);
    await runWorldJobs(job(seed, bound.llm));
    expect(bound.requests).toEqual([]);
    const read = card(seed);
    expect(read.summary).toBeNull();
    expect(read.coverage.gaps).toContain("pending_consolidation");
  } finally { db.close(); }
});

import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { insertClaim, getClaim } from "../../src/claims/store";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { ulid } from "../../src/util/ulid";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { WORLD_ADMISSION_SCHEMA } from "../../src/contracts/world-admission";
import { DEFAULT_CONSOLIDATION_CONFIG } from "../../src/contracts/consolidation";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { resetWorldTables } from "../../src/world/tables/registry";
import { LEDGER_SCHEMA_VERSION } from "../../src/ledger/db";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { consolidationDoctor } from "../../src/serve/doctor-consolidation";
import { CONSOLIDATION_CALLS } from "../../src/serve/consolidate";
import { readDailyBudget, budgetDay } from "../../src/serve/budget-ledger";
import { PortError } from "../../src/contracts/ports";
import { canonFixture, budget } from "../canon/helpers";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldClaimHandle, worldCanonPath } from "../../src/canon/world-materialization";
import { correct } from "../../src/correction/correct";
import { initSearch } from "../../src/search";
import { initGraph } from "../../src/graph";
import { purgeEvents } from "../../src/ledger/purge";

setDefaultTimeout(30_000);
async function additional(seed: WorldSeed, text: string, sensitivity: "public" | "private" = "public", metadata: Record<string, unknown> = {}, extra: Partial<ClaimV2Assertion> = {}) {
  const db = seed.ctx.db, grant = inspectSourceGrant(db, seed.sourceKey)!;
  const prior = readClaimV2Semantic(db, seed.claims[2]!)!;
  if (prior.discriminator !== "assertion") throw new Error("synthetic definition is not an assertion");
  const received = accept(db, { ...validEvent(), connector_id: grant.connector_id, source_record_id: ulid(),
    text, subjects: [...new Set([prior.subject, ...(extra.context ?? []), extra.perspective?.holder, extra.perspective?.speaker, extra.perspective?.addressee].flatMap((ref) => ref == null ? [] : [ref.id]))].map((subject_id) => ({ subject_id, role: "about" })), sensitivity_hint: sensitivity, metadata },
    { source: { source_key: seed.sourceKey, expected_revision: grant.revision } });
  if (received.status !== "stored") throw new Error("extra synthetic evidence not captured");
  const semantic: ClaimV2Assertion = { ...prior, schema: "kizuki.claim/v2", discriminator: "assertion",
    object: { kind: "literal", value: text }, anchors: [{ event_id: received.event.event_id, start_utf16: 0, end_utf16: text.length }],
    perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, ...extra,
    ...(extra.perspective === undefined ? {} : { perspective: { ...extra.perspective, anchors: [{ event_id: received.event.event_id, start_utf16: 0, end_utf16: text.length }] } }),
  } as ClaimV2Assertion;
  const stored = await insertClaim({ db }, { kind: "claim", body: text, provenance: [received.event.event_id], producer: "deterministic",
    confidence: .8, sensitivity, subjects: [prior.subject.id], semantic, world_admission: { schema: WORLD_ADMISSION_SCHEMA,
      semantic, rendering: { body: text, frontmatter: {} }, authority: "model_inference", confidence: .5, epistemicKind: "model_inference" } });
  expect(["stored", "duplicate"]).toContain(stored.outcome);
  writeRailCursor(db, "kizuki.producer.model", "extract", `${db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(received.event.event_id)!.accepted_at}\t${received.event.event_id}`);
}
function rows(db: ReturnType<typeof openLedger>, table: string) { return db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n; }

test("new authorized evidence makes the old summary stale until an exact replacement is committed", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db); authorizeModel(seed);
    await runWorldJobs(job(seed, bound.llm));
    await additional(seed, "Bayesian updating combines prior beliefs and likelihood evidence.");
    expect(card(seed).summary).toBeNull();
    expect(card(seed).coverage.gaps).toContain("stale_dependencies");
    await runWorldJobs(job(seed, bound.llm));
    expect(bound.requests).toHaveLength(2);
    expect(card(seed).summary?.text).toBe(SUMMARY);
    expect(card(seed).coverage.gaps).not.toContain("stale_dependencies");
  } finally { db.close(); }
});

test("complete empty is durable and support changes invalidate it", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db, { reply: JSON.stringify({ schema: "kizuki.consolidation-response/v1", status: "complete", summary: null }) });
    authorizeModel(seed);
    await runWorldJobs(job(seed, bound.llm)); await runWorldJobs(job(seed, bound.llm));
    expect(bound.requests).toHaveLength(1);
    expect(card(seed).summary).toBeNull(); expect(card(seed).coverage.gaps).not.toContain("pending_consolidation");
    await additional(seed, "Evidence can revise the prior in either direction.");
    expect(card(seed).coverage.gaps).toContain("stale_dependencies");
    await runWorldJobs(job(seed, bound.llm)); expect(bound.requests).toHaveLength(2);
  } finally { db.close(); }
});

for (const [expected, reply] of [
  ["empty", ""], ["rejected", "not JSON"],
  ["partial", JSON.stringify({ schema: "kizuki.consolidation-response/v1", status: "partial", summary: "unfinished" })],
  ["truncated", JSON.stringify({ schema: "kizuki.consolidation-response/v1", status: "truncated", summary: "unfinished" })],
] as const) test(`${expected} model outcome remains pending, backs off, and never commits a successful checkpoint`, async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db, { reply }); authorizeModel(seed);
    const at = Date.now(), ctx = { ...job(seed, bound.llm), now: () => new Date(at).toISOString() };
    await runWorldJobs(ctx); await runWorldJobs(ctx);
    expect(bound.requests).toHaveLength(1);
    expect(db.query("SELECT status,summary,completed_at FROM world_consolidation").get()).toEqual({ status: "pending", summary: null, completed_at: null });
    expect(db.query("SELECT outcome FROM world_consolidation_jobs WHERE basis_digest IS NOT NULL").get()).toEqual({ outcome: expected });
    expect(card(seed).coverage.gaps).toContain("pending_consolidation");
    const health = consolidationDoctor(db, ctx.now(), true);
    expect(health.last_failure?.outcome).toBe(expected); expect(health.last_success_at).toBeNull();
    await runWorldJobs({ ...ctx, now: () => new Date(at + 61_000).toISOString() });
    expect(bound.requests).toHaveLength(2);
  } finally { db.close(); }
});

test("model unavailability does not leak its error or advance success", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db, { onCall: () => { throw new PortError("unavailable", "PRIVATE fixture provider diagnostic", true); } });
    authorizeModel(seed); expect((await runWorldJobs(job(seed, bound.llm))).errors).toEqual([]);
    const health = consolidationDoctor(db, new Date().toISOString(), true);
    expect(health.last_failure?.outcome).toBe("unavailable");
    expect(JSON.stringify(health)).not.toContain("PRIVATE"); expect(card(seed).summary).toBeNull();
  } finally { db.close(); }
});

test("daily model admission survives derived rebuild and reports the exact budget stop", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db); authorizeModel(seed);
    const ctx = { ...job(seed, bound.llm), consolidation: { ...DEFAULT_CONSOLIDATION_CONFIG, max_calls_per_day: 1 } };
    await runWorldJobs(ctx); resetWorldTables(db, LEDGER_SCHEMA_VERSION);
    expect(card(seed).summary).toBeNull(); expect(card(seed).coverage.gaps).toContain("pending_consolidation");
    expect((await runWorldJobs(ctx)).reason).toBe("consolidation:budget_day");
    expect(bound.requests).toHaveLength(1);
    expect(readDailyBudget(db, budgetDay(ctx.now()), CONSOLIDATION_CALLS)).toBe(1);
    expect(consolidationDoctor(db, ctx.now(), true, ctx.consolidation).stopped).toBe("consolidation:budget_day");
  } finally { db.close(); }
});

test("revocation during a real asynchronous port call erases its basis and cannot resurrect the result", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db); authorizeModel(seed);
    const bound = model(db, { onCall: async () => {
      await Promise.resolve();
      revokeSourceGrant(db, { source_key: seed.sourceKey, expected_revision: 2, operation_id: "revoke-inflight-summary" });
      expect(rows(db, "world_consolidation")).toBe(0);
    } });
    expect((await runWorldJobs(job(seed, bound.llm))).errors).toEqual([]);
    expect(bound.requests).toHaveLength(1); expect(rows(db, "world_consolidation")).toBe(0);
    expect(db.query("SELECT 1 FROM world_consolidation_jobs WHERE basis_digest IS NOT NULL").get()).toBeNull();
  } finally { db.close(); }
});

test("purge in flight and world rebuild in flight cannot recreate deleted requests", async () => {
  for (const erase of ["purge", "rebuild"] as const) {
    const f = canonFixture();
    try {
      const raw = await worldSeed(f.db), seed = { ...raw, ctx: { ...raw.ctx, vaultPath: f.vault } }; authorizeModel(seed);
      const bound = model(f.db, { onCall: () => {
        if (erase === "purge") purgeEvents(f.db, f.vault, { event_id: seed.eventId }, "purge-summary-source");
        else resetWorldTables(f.db, LEDGER_SCHEMA_VERSION);
      } });
      expect((await runWorldJobs(job(seed, bound.llm))).errors).toEqual([]);
      expect(bound.requests).toHaveLength(1); expect(rows(f.db, "world_consolidation")).toBe(0);
      expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { f.dispose(); }
  }
});

test("actual owner correction committed during summarization wins over the captured result", async () => {
  const f = canonFixture();
  try {
    initSearch(f.db); initGraph(f.db);
    const raw = await worldSeed(f.db), seed = { ...raw, ctx: { ...raw.ctx, vaultPath: f.vault } }; authorizeModel(seed);
    const claims = seed.claims.map((id) => getClaim(f.db, id)!);
    applyCanonWrite(f.io, claims, { action: "create", rel_path: worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!) }, { writer: "loop", budget: budget() });
    const bound = model(f.db, { onCall: async () => {
      const corrected = await correct(f.io, { statement: "Use prior odds and the likelihood ratio.", target: { claim_id: seed.claims[2]! } });
      expect(corrected.receipt_id).not.toBeNull();
    } });
    expect((await runWorldJobs(job(seed, bound.llm))).errors).toEqual([]);
    expect(bound.requests).toHaveLength(1); expect(rows(f.db, "world_consolidation")).toBe(0);
    const read = card(seed); expect(read.summary).toBeNull();
    expect(JSON.stringify(read.definitions)).toContain("Use prior odds and the likelihood ratio.");
  } finally { f.dispose(); }
});

test("hidden-only new supports cannot change a narrower reader's summary, gaps, bytes or work", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db); authorizeModel(seed); await runWorldJobs(job(seed, bound.llm));
    const registered = addAgent(db, "summary-public", { ...OWNER_AGENT_GRANT, ceiling: "public" });
    const principal = authenticate(db, registered.token)!;
    const narrow = { ...seed, ctx: { ...seed.ctx, principal } };
    const before = collectReadFrames(() => card(narrow)); expect(before.result.summary?.text).toBe(SUMMARY);
    await additional(seed, "Private contextual evidence must stay hidden.", "private");
    const unchanged = collectReadFrames(() => card(narrow));
    expect(unchanged.result).toEqual(before.result); expect(unchanged.frames.map((f) => f.stats)).toEqual(before.frames.map((f) => f.stats));
    expect(card(seed).summary).toBeNull(); expect(card(seed).coverage.gaps).toContain("stale_dependencies");
    await runWorldJobs(job(seed, bound.llm));
    const after = collectReadFrames(() => card(narrow));
    expect(after.result).toEqual(before.result); expect(after.frames.map((f) => f.stats)).toEqual(before.frames.map((f) => f.stats));
    expect(JSON.stringify(after.result)).not.toContain("Private contextual");
  } finally { db.close(); }
});

test("a narrower reader never receives a summary produced from a wider basis", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db); authorizeModel(seed);
    await additional(seed, "Private contextual evidence must stay hidden.", "private"); await runWorldJobs(job(seed, bound.llm));
    const registered = addAgent(db, "summary-narrow", { ...OWNER_AGENT_GRANT, ceiling: "public" });
    const narrow = { ...seed, ctx: { ...seed.ctx, principal: authenticate(db, registered.token)! } };
    expect(card(seed).summary?.text).toBe(SUMMARY);
    expect(card(narrow).summary).toBeNull(); expect(card(narrow).coverage.gaps).toContain("pending_consolidation");
    expect(card(narrow).coverage.gaps).not.toContain("stale_dependencies");
  } finally { db.close(); }
});

test("prompt text passes the shared scrubber and copy lineage never becomes independent confidence", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db); authorizeModel(seed);
    await additional(seed, "The fixture secret is api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890", "public", { lineage: { kind: "paraphrase" } });
    const before = db.query("SELECT claim_id,confidence FROM claims ORDER BY claim_id").all();
    await runWorldJobs(job(seed, bound.llm));
    expect(bound.requests).toHaveLength(1);
    const prompt = JSON.stringify(bound.requests[0]!.messages);
    expect(prompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890"); expect(prompt).toContain("redacted");
    expect(db.query("SELECT claim_id,confidence FROM claims ORDER BY claim_id").all()).toEqual(before);
  } finally { db.close(); }
});

import { tempVault } from "../helpers/vault";
import { join } from "node:path";
import { assertLedgerSchema } from "../../src/ledger/integrity";

test("a crash after request admission reopens as pending and retries only after its lease", async () => {
  const vault = tempVault("consolidation-recovery-");
  const path = join(vault.path, "consolidation.db");
  let db = openLedger(path);
  try {
    const seed = await worldSeed(db); authorizeModel(seed);
    const started = Date.now(), bound = model(db, { onCall: () => { db.close(); } });
    const failed = await runWorldJobs({ ...job(seed, bound.llm), now: () => new Date(started).toISOString() });
    expect(failed.errors).toHaveLength(1); expect(bound.requests).toHaveLength(1);
    db = openLedger(path);
    const reopened = { ...seed, ctx: { ...seed.ctx, db } }, retry = model(db);
    expect(card(reopened).summary).toBeNull();
    await runWorldJobs({ ...job(reopened, retry.llm), now: () => new Date(started + 1_000).toISOString() });
    expect(retry.requests).toHaveLength(0);
    await runWorldJobs({ ...job(reopened, retry.llm), now: () => new Date(started + 181_000).toISOString() });
    expect(retry.requests).toHaveLength(1); expect(card(reopened).summary?.text).toBe(SUMMARY);
    db.close(); db = openLedger(path);
    const finished = { ...seed, ctx: { ...seed.ctx, db } }, repeat = model(db);
    await runWorldJobs({ ...job(finished, repeat.llm), now: () => new Date(started + 182_000).toISOString() });
    expect(repeat.requests).toHaveLength(0); expect(card(finished).summary?.text).toBe(SUMMARY);
  } finally { db.close(); vault.dispose(); }
});

test("fresh and upgraded storage preserve authority while rebuilding the derived summary tables", async () => {
  const vault = tempVault("consolidation-migration-");
  const path = join(vault.path, "consolidation.db");
  let db = openLedger(path);
  try {
    const seed = await worldSeed(db), before = db.query("SELECT claim_id,status FROM claims ORDER BY claim_id").all();
    expect(() => assertLedgerSchema(db, LEDGER_SCHEMA_VERSION)).not.toThrow();
    for (const { name } of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'world_consolidation_%'").all()) db.exec(`DROP TRIGGER ${name}`);
    db.exec("DROP TABLE world_consolidation_jobs; DROP TABLE world_consolidation_basis; DROP TABLE world_consolidation; UPDATE schema_version SET version=41");
    db.close(); db = openLedger(path);
    expect(() => assertLedgerSchema(db, LEDGER_SCHEMA_VERSION)).not.toThrow();
    expect(db.query("SELECT claim_id,status FROM claims ORDER BY claim_id").all()).toEqual(before);
    expect(rows(db, "world_consolidation")).toBe(0); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(card({ ...seed, ctx: { ...seed.ctx, db } }).coverage.gaps).toContain("pending_consolidation");
  } finally { db.close(); vault.dispose(); }
});

test("historical reads never borrow a summary produced after their exact retained basis", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db); authorizeModel(seed);
    const before = new Date().toISOString();
    await runWorldJobs({ ...job(seed, bound.llm), now: () => new Date(Date.parse(before) + 10_000).toISOString() });
    expect(card(seed).summary?.text).toBe(SUMMARY);
    const read = readWorldView(seed.ctx, { operation: "concept", concept: seed.ref,
      valid: { kind: "all" }, knownAt: { kind: "time", at: before } });
    if (!("result" in read) || read.result.status === "unavailable" || read.result.data.schema !== "kizuki.concept-card/v1") throw new Error("historical fixture read unavailable");
    expect(read.result.data.summary).toBeNull(); expect(read.result.data.coverage.gaps).toContain("pending_consolidation");
  } finally { db.close(); }
});

test("saved snapshots cannot gain a summary completed later at the identical recorded timestamp", async () => {
  const db = openLedger(":memory:"), instant = "2030-01-09T00:00:00.000Z";
  try {
    db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(instant);
    const seed = await worldSeed(db), bound = model(db); authorizeModel(seed);
    const input = { operation: "concept", concept: seed.ref, valid: { kind: "all" }, knownAt: { kind: "time", at: instant } };
    const read = (knownAt = input.knownAt as unknown) => {
      const result = readWorldView(seed.ctx, { ...input, knownAt });
      if (!("result" in result) || !("data" in result.result) || result.result.data.schema !== "kizuki.concept-card/v1") throw new Error("historical card missing");
      return result.result.data;
    };
    const before = read();
    expect(before.knownAt.kind).toBe("snapshot"); expect(before.summary).toBeNull();
    expect(before.coverage.gaps).toContain("pending_consolidation");
    await runWorldJobs({ ...job(seed, bound.llm), now: () => instant });
    expect(bound.requests).toHaveLength(1);
    expect(card(seed).summary?.text).toBe(SUMMARY);
    const retained = read(before.knownAt);
    expect(retained.summary).toBeNull(); expect(retained.coverage.gaps).toContain("pending_consolidation");
    const fresh = read();
    expect(fresh.summary?.text).toBe(SUMMARY);
    expect(read(fresh.knownAt).summary).toEqual(fresh.summary);
    expect(read(before.knownAt).summary).toBeNull();
  } finally { db.close(); }
});

test("loss of derive consent and an unbound destination both prevent model egress", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db), bound = model(db); authorizeModel(seed);
    const unbound = { ...bound.llm };
    await runWorldJobs(job(seed, unbound)); expect(bound.requests).toHaveLength(0);
    const grant = inspectSourceGrant(db, seed.sourceKey)!;
    setSourceGrant(db, { source_key: seed.sourceKey, expected_revision: grant.revision, operation_id: "no-derived-summary",
      policy: { ...grant.policy, purposes: grant.policy.purposes.filter((purpose) => purpose !== "derive") } });
    await runWorldJobs(job(seed, bound.llm)); expect(bound.requests).toHaveLength(0);
    expect(card(seed).summary).toBeNull();
  } finally { db.close(); }
});

test("stop requests cancel the port and cannot publish a late answer", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db); authorizeModel(seed); let stop = false, sawAbort = false;
    const bound = model(db, { onCall: async () => { stop = true; await new Promise((resolve) => setTimeout(resolve, 200)); } });
    const original = bound.llm.complete;
    bound.llm.complete = async (request) => { request.signal?.addEventListener("abort", () => { sawAbort = true; }); return original(request); };
    const result = await runWorldJobs({ ...job(seed, bound.llm), stopRequested: () => stop });
    expect(result.stopped).toBe(true); expect(sawAbort).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(card(seed).summary).toBeNull(); expect(db.query("SELECT status FROM world_consolidation").get()).toEqual({ status: "pending" });
  } finally { db.close(); }
});

test("a 2000-handle corpus consumes only its handle budget and resumes without repeating completed work", async () => {
  const db = openLedger(":memory:");
  try {
    const first = await worldSeed(db, { subject: "topic:corpus-0", label: "Corpus 0", discover: false });
    let last = first;
    for (let i = 1; i < 2_000; i++) last = await worldSeed(db, { subject: `topic:corpus-${i}`, label: `Corpus ${i}`, sourceKey: first.sourceKey, discover: false });
    authorizeModel(last);
    const bound = model(db), ctx = { ...job(first, bound.llm), consolidation: { ...DEFAULT_CONSOLIDATION_CONFIG, max_handles_per_pass: 7, max_calls_per_pass: 32 } };
    expect((await runWorldJobs(ctx)).errors).toEqual([]); expect(bound.requests).toHaveLength(7); expect(rows(db, "world_consolidation")).toBe(7);
    expect((await runWorldJobs(ctx)).errors).toEqual([]); expect(bound.requests).toHaveLength(14); expect(rows(db, "world_consolidation")).toBe(14);
  } finally { db.close(); }
}, 180_000);

test("two speakers and conflicting dates survive structured prompt projection and remain attributed", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db); authorizeModel(seed);
    const namespace = { connector_id: "world.fixture", source_key: seed.sourceKey };
    const alpha = { kind: "supplied" as const, id: "person:alpha", namespace }, beta = { kind: "supplied" as const, id: "person:beta", namespace };
    const project = { kind: "supplied" as const, id: "project:synthetic", namespace };
    await additional(seed, "Alpha reports the milestone occurs on January 1.", "public", {}, {
      valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-01-02T00:00:00.000Z", context: [project],
      perspective: { holder: alpha, speaker: alpha, addressee: beta, mode: "reported", interpretation: "explicit", anchors: [] },
    });
    await additional(seed, "Beta reports the milestone occurs on February 1.", "public", {}, {
      valid_from: "2026-02-01T00:00:00.000Z", valid_to: "2026-02-02T00:00:00.000Z", context: [project],
      perspective: { holder: beta, speaker: beta, addressee: alpha, mode: "reported", interpretation: "explicit", anchors: [] },
    });
    const attributed = "Alpha reports January 1; Beta reports February 1. Their dates disagree.";
    const bound = model(db, { reply: JSON.stringify({ schema: "kizuki.consolidation-response/v1", status: "complete", summary: attributed }) });
    await runWorldJobs(job(seed, bound.llm)); expect(bound.requests).toHaveLength(1);
    const user = bound.requests[0]!.messages[1]!.content;
    const payload = JSON.parse(user.slice(user.indexOf("\n") + 1, user.lastIndexOf("\n"))) as { assertions: ClaimV2Assertion[] };
    const reported = payload.assertions.filter((assertion) => assertion.perspective.mode === "reported");
    expect(reported).toHaveLength(2);
    expect(reported.map((assertion) => [assertion.perspective.speaker?.id, assertion.valid_from]).sort()).toEqual([
      [alpha.id, "2026-01-01T00:00:00.000Z"], [beta.id, "2026-02-01T00:00:00.000Z"],
    ]);
    for (const assertion of reported) { expect(assertion.context).toEqual([project]); expect(assertion.subject).toBeDefined(); expect(assertion.anchors.length).toBeGreaterThan(0); }
    expect(card(seed).summary?.text).toBe(attributed);
  } finally { db.close(); }
});

test("observed overage is charged to the reserved day across midnight, erasure, and reopen", async () => {
  const vault = tempVault("consolidation-usage-");
  const path = join(vault.path, "consolidation.db"); let db = openLedger(path);
  try {
    const seed = await worldSeed(db); authorizeModel(seed);
    const day = new Date().toISOString().slice(0, 10), start = `${day}T23:59:59.000Z`;
    let now = start;
    const bound = model(db, { outputTokens: 2_048, onCall: () => {
      now = new Date(Date.parse(start) + 2_000).toISOString(); resetWorldTables(db, LEDGER_SCHEMA_VERSION);
    } });
    expect((await runWorldJobs({ ...job(seed, bound.llm), now: () => now })).errors).toEqual([]);
    expect(rows(db, "world_consolidation")).toBe(0);
    expect(readDailyBudget(db, day, "consolidation_output_tokens_per_day")).toBe(2_048);
    expect(readDailyBudget(db, day, "consolidation_observed_output_tokens")).toBe(2_048);
    expect(readDailyBudget(db, budgetDay(now), "consolidation_output_tokens_per_day")).toBe(0);
    db.close(); db = openLedger(path);
    expect(readDailyBudget(db, day, "consolidation_output_tokens_per_day")).toBe(2_048);
    expect(rows(db, "world_consolidation")).toBe(0);
  } finally { db.close(); vault.dispose(); }
});
