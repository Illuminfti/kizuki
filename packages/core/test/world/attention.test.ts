import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setAttentionDisposition } from "../../src/world/attention/state";
import { attentionBudgetSnapshot, ATTENTION_DELIVERY_LIMIT, deliverAttention, deliverPendingAttention } from "../../src/world/attention/deliver";
import {
  assessDomainDepth,
  compileDomainTaste,
  computeInterestSalience,
  createExpansionLedger,
  evaluateDomainExpansion,
  readDomainGraph,
  recordExpansionStep,
  stopDomainExpansion,
  undoExpansionReceipt,
  validateTasteRecord,
  type InterestSignal,
  type TasteRecord,
} from "../../src/world/attention/adaptive-domain";
import { activeWorldOps } from "../../src/world/ops/registry";
import { worldNamespace } from "../../src/world/references";
import { serveWorldView } from "../../src/serving/world-view";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { ulid } from "../../src/util/ulid";
import { attentionFixture, ATTENTION_WHEN } from "../helpers/attention-fixture";
import { bindSourceModelPort } from "../../src/ledger/source-grants";
import type { LlmPort } from "../../src/contracts/llm";
import { writeRailCursor } from "../../src/ledger/checkpoints";
import { runWorldJobs } from "../../src/serve/world-jobs";
import { runRail } from "../../src/serve/rails";
import { EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "../../../../rfcs/fixtures", `${name}-design.json`), "utf8"));

test("48 nonmaterial mentions are quiet, with an explicit reason and no interrupt", async () => {
  const oracle = fixture("world-cue-quiet"), f = await attentionFixture({ blocker: false });
  try {
    for (let i = 0; i < oracle.candidate.mention_count; i++) accept(f.db, { ...validEvent(), connector_id: "fixture", source_record_id: ulid(), text: "A repeated mention without a material change", subjects: [{ subject_id: "situation:attention", role: "about" }] }, { source: { source_key: f.situation.sourceKey, expected_revision: 1 } });
    await f.complete();
    expect(f.read().states).toEqual([{ state: "quiet", reason: oracle.delivery.quiet_reason }]);
    expect(await deliverPendingAttention(f.ctx)).toEqual({ delivered: 0, duplicate: 0, pending: 0 });
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM world_attention_state").get()!.n).toBe(0);
  } finally { f.dispose(); }
}, 120_000);

test("an actual rejected consolidation call is provider failure, never quiet", async () => {
  const f = await attentionFixture({ complete: false }); let calls = 0;
  try {
    const event = f.db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(f.situation.eventId)!;
    writeRailCursor(f.db, "kizuki.producer.model", "extract", `${event.accepted_at}\t${f.situation.eventId}`);
    const llm = bindSourceModelPort({ descriptor: { id: "synthetic.attention-failure", kind: "llm", contract: "kizuki.llm/v1", contract_minor: 0, supports: ["chat"], requires_lease: false, optional_package: null },
      model_ref: "synthetic.attention-failure", health: async () => ({ status: "ready", detail: {} }), close: async () => {},
      complete: async () => { calls++; return { text: "invalid response", model: EMPTY_SUMMARY_MODEL.model, usage: { input_tokens: 1, output_tokens: 1 } }; },
    } satisfies LlmPort, EMPTY_SUMMARY_MODEL);
    await runWorldJobs({ db: f.db, vaultPath: f.vault.path, now: () => new Date().toISOString(), stopRequested: () => false, modelConfigured: true, llm });
    expect(calls).toBeGreaterThan(0);
    expect(f.read().states).toContainEqual({ state: "provider_failure", reason: "provider_error" });
    expect(f.read().states.some(state => state.state === "quiet")).toBe(false);
    expect(await deliverPendingAttention(f.ctx)).toMatchObject({ delivered: 0 });
  } finally { f.dispose(); }
}, 120_000);

test("visible disagreement produces uncertainty instead of a single asserted blocker", async () => {
  const f = await attentionFixture({ blocker: false });
  try {
    await f.seed("situation:uncertain", { predicates: [
      { predicate: "situation.objective", object: { kind: "literal", value: "Deliver an independently checked artifact" } },
      { predicate: "situation.blocker", object: { kind: "literal", value: "Inspection is blocked" }, polarity: "negative" },
    ] });
    await f.complete();
    expect(f.candidates().map(cue => cue.source)).toEqual(["uncertainty"]);
  } finally { f.dispose(); }
}, 120_000);

test("explicit objective supplies relevance and delivery has its own bounded budget", async () => {
  const f = await attentionFixture({ objective: false });
  try {
    expect(f.candidates()).toHaveLength(0);
    for (let index = 0; index < 10; index++) await f.seed(`situation:relevant-${index}`, { predicates: [
      { predicate: "situation.objective", object: { kind: "literal", value: "Inspect the artifact" } },
      { predicate: "situation.blocker", object: { kind: "literal", value: "Independent review is blocked" } },
    ] });
    await f.complete();
    expect(f.candidates()).toHaveLength(10);
    expect(await deliverPendingAttention(f.ctx)).toEqual({ delivered: 4, duplicate: 0, pending: 6 });
  } finally { f.dispose(); }
}, 120_000);

test("dismissal and snooze affect only attention, with historical reads explicitly unavailable", async () => {
  const oracle = fixture("world-cue-dismissal"), f = await attentionFixture();
  try {
    const cue = f.candidates()[0]!;
    const before = f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all();
    const support = f.db.query("SELECT support_key,admission FROM claim_v2_support ORDER BY support_key").all();
    expect(setAttentionDisposition(f.ctx, cue.cue, "dismiss").disposition).toBe("dismissed");
    expect(await deliverAttention(f.ctx, cue.cue)).toEqual({ status: "suppressed" });
    expect(f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all()).toEqual(before);
    expect(f.db.query("SELECT support_key,admission FROM claim_v2_support ORDER BY support_key").all()).toEqual(support);
    expect(oracle.oracle.canon_gated).toBe(false);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM canon_receipts").get()!.n).toBe(0);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(setAttentionDisposition(f.ctx, cue.cue, "snooze", until)).toMatchObject({ disposition: "snoozed", snoozedUntil: until });
    expect(await deliverPendingAttention(f.ctx)).toEqual({ delivered: 0, duplicate: 0, pending: 0 });
    expect(serveWorldView(f.ctx, { operation: "attention", ...ATTENTION_WHEN, knownAt: { kind: "time", at: "2026-01-01T00:00:00.000Z" } }).data).toMatchObject({ result: { status: "unavailable", reason: "history" } });
  } finally { f.dispose(); }
}, 120_000);

test("file notifier returns duplicate for a repeated candidate and preserves one brief line", async () => {
  const f = await attentionFixture();
  try {
    const cue = f.candidates()[0]!.cue;
    expect(await deliverAttention(f.ctx, cue)).toMatchObject({ status: "delivered", receipt: { duplicate: false } });
    const path = join(f.vault.path, "dashboards", `attention-${cue}.md`), before = statSync(path).mtimeMs;
    expect(await deliverAttention(f.ctx, cue)).toMatchObject({ status: "delivered", receipt: { duplicate: true } });
    expect(statSync(path).mtimeMs).toBe(before);
    expect(readFileSync(path, "utf8").split("\n").filter(line => line.startsWith("- "))).toHaveLength(1);
    expect(readdirSync(join(f.vault.path, "dashboards")).filter(name => name.startsWith("attention-"))).toHaveLength(1);
  } finally { f.dispose(); }
}, 120_000);

test("the registered brief rail delivers current attention once alongside its daily page", async () => {
  const f = await attentionFixture();
  try {
    const cue = f.candidates()[0]!.cue;
    const now = new Date().toISOString();
    const run = () => runRail(f.db, f.vault.path, "brief", { now: () => now });
    const first = await run();
    expect(first.status).toBe("ok");
    expect(first.model.calls).toBe(0);
    const path = join(f.vault.path, "dashboards", `attention-${cue}.md`);
    const before = readFileSync(path, "utf8"), modified = statSync(path).mtimeMs;
    expect(before).toContain(cue);
    expect((await run()).status).toBe("ok");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(modified);
    expect(readdirSync(join(f.vault.path, "dashboards")).filter(name => name.startsWith("attention-"))).toHaveLength(1);
  } finally { f.dispose(); }
}, 120_000);

test("missing coverage, stale consolidation, provider failure and quiet stay distinct", async () => {
  const oracle = fixture("world-cue-coverage"), missing = await attentionFixture({ coverage: false }), stale = await attentionFixture({ complete: false });
  try {
    expect(missing.read().states).toContainEqual({ state: "missing_coverage", reason: oracle.states.missing_coverage.reason });
    expect(stale.read().states).toContainEqual({ state: "stale_consolidation", reason: oracle.states.stale_consolidation.reason });
    expect(stale.read().states).toContainEqual({ state: "provider_failure", reason: oracle.states.provider_failure.reason });
    expect(missing.read().states.some(state => state.state === "quiet")).toBe(false);
    expect(stale.read().states.some(state => state.state === "quiet")).toBe(false);
    expect(await deliverPendingAttention(stale.ctx)).toMatchObject({ delivered: 0 });
  } finally { missing.dispose(); stale.dispose(); }
}, 120_000);

test("new visible evidence makes an old goal summary stale and holds delivery", async () => {
  const f = await attentionFixture();
  try {
    expect(f.read().coverage.status).toBe("complete_for_query");
    await f.seed("situation:attention", { sourceKey: f.situation.sourceKey, predicates: [
      { predicate: "situation.change", object: { kind: "literal", value: "An independent review was requested" } },
    ] });
    expect(f.read().states).toContainEqual({ state: "stale_consolidation", reason: "summary_older_than_ledger" });
    expect(f.candidates().some(cue => cue.source === "stale_summary")).toBe(true);
    expect(await deliverPendingAttention(f.ctx)).toMatchObject({ delivered: 0 });
  } finally { f.dispose(); }
}, 120_000);

test("delivery budget accepts narrower caller caps and enforces the hard interruption ceiling", async () => {
  const f = await attentionFixture({ objective: false });
  try {
    for (let index = 0; index < 6; index++) await f.seed(`situation:budget-${index}`, { predicates: [
      { predicate: "situation.objective", object: { kind: "literal", value: "Verify bounded interruption caps" } },
      { predicate: "situation.blocker", object: { kind: "literal", value: "Review is pending" } },
    ] });
    await f.complete();
    const snap = f.db.transaction(() => {
      const ns = worldNamespace(f.db, f.ctx.principal);
      const read = f.read();
      return {
        narrow: attentionBudgetSnapshot({ data: read, entries: f.candidates().map(candidate => ({ candidate, handle: "h", dependencies: { children: [], forecasts: new Map(), observations: new Map(), claims: new Set(), legacyClaims: new Map(), supports: new Set(), events: new Set(), identityReceipts: new Map(), consolidations: new Map(), coverage: null }, sources: [], deliveredAt: null })) }, { maxDeliveries: 2 }),
        overCap: attentionBudgetSnapshot({ data: read, entries: [] }, { maxDeliveries: 99 }),
        ns,
      };
    }).immediate();
    expect(snap.narrow.effectiveDeliveryCap).toBe(2);
    expect(snap.overCap.effectiveDeliveryCap).toBe(ATTENTION_DELIVERY_LIMIT);
    expect(await deliverPendingAttention(f.ctx, { maxDeliveries: 2 })).toEqual({ delivered: 2, duplicate: 0, pending: 4 });
    expect(await deliverPendingAttention(f.ctx, { maxDeliveries: 99 })).toEqual({ delivered: 4, duplicate: 0, pending: 0 });
  } finally { f.dispose(); }
}, 120_000);

test("A1 interest salience decays with time, ignores dependent copies and summary replays, and yields to owner retraction", () => {
  const now = "2030-03-02T00:00:00.000Z";
  const ev = (tok: string) => [{
    admission: { kind: "admission" as const, token: `a_${tok.padEnd(41, "0")}` },
    eventVersion: { kind: "event_version" as const, token: `e_${tok.padEnd(41, "0")}` },
    span: { kind: "text" as const, startUtf16: 0, endUtf16: 12 },
  }];
  const isolated: InterestSignal[] = [{
    id: "visit-1", kind: "visit", domain: "Poster design", evidenceKey: "ev-1",
    observedAt: now, independence: "independent", polarity: "positive", evidence: ev("1"),
  }];
  const single = computeInterestSalience(isolated, now);
  expect(single.stage).toBe("hypothesis");
  expect(single.independentCount).toBe(1);
  expect(single.establishesCompetence).toBe(false);

  // Copies and generated summary replays never deepen an isolated visit.
  const withCopiesAndSummaries: InterestSignal[] = [
    ...isolated,
    { id: "copy-1", kind: "visit", domain: "Poster design", evidenceKey: "ev-2", observedAt: now, independence: "dependent", polarity: "positive", evidence: ev("2") },
    { id: "summary-1", kind: "generated_summary", domain: "Poster design", evidenceKey: "ev-3", observedAt: now, independence: "independent", polarity: "positive", evidence: ev("3") },
    { id: "summary-2", kind: "generated_summary", domain: "Poster design", evidenceKey: "ev-4", observedAt: now, independence: "independent", polarity: "positive", evidence: ev("4") },
  ];
  const replayed = computeInterestSalience(withCopiesAndSummaries, now);
  expect(replayed.stage).toBe("hypothesis");
  expect(replayed.salience).toBe(single.salience);
  expect(replayed.independentCount).toBe(1);
  expect(replayed.dependentCount).toBe(1);
  expect(replayed.summaryReplayCount).toBe(2);

  // Independent evidence deepens interest and decays with exact 30-day half-life.
  const deepSignals: InterestSignal[] = [
    ...isolated,
    { id: "q-1", kind: "explicit_question", domain: "Poster design", evidenceKey: "ev-q1", observedAt: now, independence: "independent", polarity: "positive", evidence: ev("q1") },
    { id: "sel-1", kind: "selection", domain: "Poster design", evidenceKey: "ev-s1", observedAt: now, independence: "independent", polarity: "positive", evidence: ev("s1") },
  ];
  const fresh = computeInterestSalience(deepSignals, now, { halfLifeDays: 30 });
  const aged = computeInterestSalience(deepSignals, "2030-04-01T00:00:00.000Z", { halfLifeDays: 30 });
  expect(fresh.stage).toBe("sustained");
  expect(fresh.independentCount).toBe(3);
  expect(fresh.establishesCompetence).toBe(false);
  expect(aged.salience).toBeCloseTo(fresh.salience * 0.5, 4);

  // Owner retraction supersedes the interest interpretation immediately.
  const retracted = computeInterestSalience([
    ...deepSignals,
    { id: "retract-1", kind: "owner_correction", domain: "Poster design", evidenceKey: "ev-ret", observedAt: now, independence: "independent", polarity: "negative", ownerAssertion: true, evidence: ev("ret") },
  ], now);
  expect(retracted.stage).toBe("retracted");
  expect(retracted.salience).toBe(0);
  expect(retracted.independentCount).toBe(0);
  expect(retracted.supersededByOwner).toBe(true);
});

test("A4 per-domain taste isolates domains, preserves accepted/rejected reasons and uncertainty, and refuses missing provenance", () => {
  const ev = (id: string) => [{
    admission: { kind: "admission" as const, token: `a_${id.padEnd(41, "0")}` },
    eventVersion: { kind: "event_version" as const, token: `e_${id.padEnd(41, "0")}` },
    span: { kind: "text" as const, startUtf16: 0, endUtf16: 20 },
  }];
  const records: TasteRecord[] = [
    {
      id: "taste-poster-sparse", domain: "Poster design", context: ["poster-layout"],
      stance: "accepted", exampleLabel: "Sparse Swiss grid poster",
      reasons: ["Generous whitespace focuses the focal typography"],
      provenance: ev("p1"), observedAt: "2030-01-01T00:00:00.000Z", independence: "independent",
    },
    {
      id: "taste-poster-cluttered", domain: "Poster design", context: ["poster-layout"],
      stance: "rejected", exampleLabel: "Dense neon card wall",
      reasons: ["Too many competing focal points dilute hierarchy"],
      provenance: ev("p2"), observedAt: "2030-01-02T00:00:00.000Z", independence: "independent",
    },
    {
      id: "taste-docs-complete", domain: "Technical documentation", context: ["api-reference"],
      stance: "accepted", exampleLabel: "Exhaustive parameter table with examples",
      reasons: ["Reference docs require complete edge-case coverage"],
      provenance: ev("d1"), observedAt: "2030-01-03T00:00:00.000Z", independence: "independent",
    },
    {
      id: "taste-no-provenance", domain: "Poster design", context: ["poster-layout"],
      stance: "accepted", exampleLabel: "Unbacked aesthetic claim",
      reasons: ["No source link"], provenance: [], observedAt: null,
    },
  ];
  expect(validateTasteRecord(records[3]!)).toEqual({ ok: false, reason: "missing_provenance" });

  const posterTaste = compileDomainTaste(records, "Poster design", { context: ["poster-layout"] });
  expect(posterTaste.status).toBe("evidenced");
  expect(posterTaste.canonApprovalQueue).toBe(false);
  expect(posterTaste.accepted.map(item => item.exampleLabel)).toEqual(["Sparse Swiss grid poster"]);
  expect(posterTaste.rejected.map(item => item.exampleLabel)).toEqual(["Dense neon card wall"]);
  expect(posterTaste.excludedInvalidCount).toBe(1);

  // Sparse poster preference must never spill into technical documentation.
  const docsTaste = compileDomainTaste(records, "Technical documentation");
  expect(docsTaste.accepted.map(item => item.exampleLabel)).toEqual(["Exhaustive parameter table with examples"]);
  expect(docsTaste.rejected).toEqual([]);
  expect(JSON.stringify(docsTaste)).not.toContain("Sparse Swiss grid poster");

  // Conflicting stances on the same example remain explicit.
  const conflicted = compileDomainTaste([
    records[0]!,
    { ...records[0]!, id: "taste-poster-sparse-reject", stance: "rejected", reasons: ["Too empty for festival bill"], provenance: ev("p3") },
  ], "Poster design");
  expect(conflicted.uncertainty).toBe("conflicted");
  expect(conflicted.conflicts).toEqual(["sparse swiss grid poster"]);
});

test("A3 and A7 bounded expansion enforces source grants, model config, budgets, owner stop, receipted undo, and summary replay immunity", async () => {
  const f = await attentionFixture();
  try {
    const ledger = createExpansionLedger({
      configuredSources: [f.situation.sourceKey],
      configuredModelEndpoint: "https://configured.example/v1",
      requiredPurpose: "extract",
      minSalience: 0.75,
      minIndependentSignals: 2,
      budget: { maxModelCalls: 2, maxTokens: 4000, maxWrites: 2, maxDepth: 2 },
    });
    const ev = [{
      admission: { kind: "admission" as const, token: "a".repeat(43) },
      eventVersion: { kind: "event_version" as const, token: "e".repeat(43) },
      span: { kind: "text" as const, startUtf16: 0, endUtf16: 10 },
    }];
    const strongTrigger = { domain: "Poster design", salience: 1.6, independentCount: 3, stage: "sustained" as const, evidenceRefs: ev };
    const weakTrigger = { domain: "Poster design", salience: 0.5, independentCount: 1, stage: "hypothesis" as const, evidenceRefs: ev };
    const stepCost = { modelCalls: 1, tokens: 1500, writes: 1, depthDelta: 1 };

    // Isolated hypothesis cannot trigger expansion.
    const weakDecision = evaluateDomainExpansion(f.ctx, ledger, {
      trigger: weakTrigger, candidateSources: [f.situation.sourceKey], requiresModel: false, coverageComplete: true, estimatedCost: stepCost,
    });
    expect(weakDecision.status).toBe("stopped");
    expect(weakDecision.stopReason).toBe("insufficient_interest");
    expect(weakDecision.silentConnectorActivation).toBe(false);

    // Unconfigured source never gets silently enabled.
    const unconfiguredDecision = evaluateDomainExpansion(f.ctx, ledger, {
      trigger: strongTrigger, candidateSources: ["01UNCONFIGURED0000000000000"], requiresModel: false, coverageComplete: true, estimatedCost: stepCost,
    });
    expect(unconfiguredDecision.status).toBe("stopped");
    expect(unconfiguredDecision.stopReason).toBe("unconfigured_source");
    expect(unconfiguredDecision.allowedSources).toEqual([]);

    // Unconfigured vault model refuses model-backed expansion.
    const noModelDecision = evaluateDomainExpansion(f.ctx, ledger, {
      trigger: strongTrigger, candidateSources: [f.situation.sourceKey], requiresModel: true, coverageComplete: true, estimatedCost: stepCost,
    });
    expect(noModelDecision.status).toBe("stopped");
    expect(noModelDecision.stopReason).toBe("unconfigured_model");

    // Permitted deterministic expansion under declared budget records receipt and respects budget ceiling.
    const allowed = evaluateDomainExpansion(f.ctx, ledger, {
      trigger: strongTrigger, candidateSources: [f.situation.sourceKey], requiresModel: false, coverageComplete: true, estimatedCost: stepCost,
    });
    expect(allowed.status).toBe("permitted");
    expect(allowed.allowedSources).toEqual([f.situation.sourceKey]);
    const rec1 = recordExpansionStep(ledger, {
      receiptId: "rcpt-exp-1", domain: "Poster design", trigger: strongTrigger,
      sources: allowed.allowedSources, modelEndpoint: null, cost: stepCost, recordedAt: "2030-01-01T00:00:00.000Z",
    });
    expect(rec1.undoneAt).toBeNull();
    recordExpansionStep(ledger, {
      receiptId: "rcpt-exp-2", domain: "Poster design", trigger: strongTrigger,
      sources: allowed.allowedSources, modelEndpoint: null, cost: stepCost, recordedAt: "2030-01-01T01:00:00.000Z",
    });
    const ceilingDecision = evaluateDomainExpansion(f.ctx, ledger, {
      trigger: strongTrigger, candidateSources: [f.situation.sourceKey], requiresModel: false, coverageComplete: true, estimatedCost: stepCost,
    });
    expect(ceilingDecision.status).toBe("stopped");
    expect(ceilingDecision.stopReason).toBe("depth_ceiling_reached");

    // Receipted undo restores depth slot; owner stop halts all further expansion while inspect/correct/undo remain open.
    const undone = undoExpansionReceipt(ledger, "rcpt-exp-2", "2030-01-01T02:00:00.000Z");
    expect(undone?.undoneAt).toBe("2030-01-01T02:00:00.000Z");
    stopDomainExpansion(ledger, "Poster design", "Owner paused domain learning", "2030-01-01T03:00:00.000Z");
    const stoppedDecision = evaluateDomainExpansion(f.ctx, ledger, {
      trigger: strongTrigger, candidateSources: [f.situation.sourceKey], requiresModel: false, coverageComplete: true, estimatedCost: stepCost,
    });
    expect(stoppedDecision.status).toBe("stopped");
    expect(stoppedDecision.stopReason).toBe("owner_stopped");

    // A7 depth report separates independent evidence from summary replays and keeps inspect/correct/undo open.
    const conceptSeed = await f.seed("topic:posters", {
      kind: "concept", label: "Poster design",
      predicates: [{ predicate: "concept.definition", object: { kind: "literal", value: "Visual communication with typographic hierarchy" } }],
    });
    const report = f.db.transaction(() => {
      const ns = worldNamespace(f.db, f.ctx.principal);
      const frame = { ctx: f.ctx, ns, registry: activeWorldOps() };
      const discovered = serveWorldView(f.ctx, { operation: "find_concepts", label: "Poster design", ...ATTENTION_WHEN }).data;
      if (!("result" in discovered) || !("data" in discovered.result) || !("matches" in discovered.result.data)) throw new Error("concept missing");
      const ref = discovered.result.data.matches[0]!.ref;
      const baseGraph = readDomainGraph(frame, ref, { kind: "all" }, { now: "2030-01-02T00:00:00.000Z" })!;
      const replayGraph = readDomainGraph(frame, ref, { kind: "all" }, {
        now: "2030-01-02T00:00:00.000Z",
        extraSignals: Array.from({ length: 12 }, (_, idx) => ({
          id: `sum-${idx}`, kind: "generated_summary" as const, domain: "Poster design",
          evidenceKey: `sum-ev-${idx}`, observedAt: "2030-01-02T00:00:00.000Z",
          independence: "independent" as const, polarity: "positive" as const, evidence: ev,
        })),
      })!;
      return {
        base: assessDomainDepth(baseGraph, ledger, "2030-01-02T00:00:00.000Z"),
        replayed: assessDomainDepth(replayGraph, ledger, "2030-01-02T00:00:00.000Z"),
        sourceKey: conceptSeed.sourceKey,
      };
    }).immediate();
    expect(report.base.stopping).toMatchObject({ stopped: true, reason: "owner_stopped", canInspect: true, canCorrect: true, canUndo: true });
    expect(report.replayed.evidencedCoverage.generatedSummaryReplayCount).toBe(12);
    expect(report.replayed.evidencedCoverage.independentEvidenceCount).toBe(report.base.evidencedCoverage.independentEvidenceCount);
    expect(report.replayed.evidencedCoverage.independentWeight).toBe(report.base.evidencedCoverage.independentWeight);
  } finally { f.dispose(); }
}, 120_000);
