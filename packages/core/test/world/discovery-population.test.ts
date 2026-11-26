/**
 * Discovery must not call a kind complete when nothing can populate it. A kind
 * that is registered, reachable only by extraction, and not offered to the
 * extraction model has no claims by design; an empty page for it is partial
 * with the gap `coverage`, never `complete_for_query`.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { insertClaim } from "../../src/claims/store";
import { EXTRACT_RESPONSE_V2_SCHEMA, type ProduceInputV2, type RichClaimDraft } from "../../src/contracts/producer-v2";
import { createWorldRegistry, type WorldVocabularyModule } from "../../src/contracts/world-kinds";
import { WORLD_REGISTRY, WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { prepareWorldDrafts } from "../../src/producer/world-drafts";
import { serveCorrect } from "../../src/serving/correct";
import { serveWorldView, type FrameworkCard, type PersonCard, type QuestionCard, type SituationCardV2 } from "@kizuki/core/world";
import type { ServeContext } from "../../src/serving/types";
import { collectReadFrames } from "@kizuki/core/testing";
import { ulid } from "../../src/util/ulid";
import {
  ALL_WORLD_KINDS,
  TYPED_EXTRACTION_KINDS,
  TYPED_KIND_COLLECTORS,
  typedKindStatements,
} from "../../src/world/collectors";
import {
  conflictEnricher,
  isSingleValuedWorldPredicate,
  kindQualificationEnricher,
  procedureEnricher,
} from "../../src/world/enrich";
import { inspectWorldKindCoverage, readWorldKindCoverage } from "../../src/world/coverage";
import { WorldHistoryUnavailable } from "../../src/world/known/cutoff";
import { COLLECTORS, collectCard } from "../../src/world/pipeline/collect";
import { ENRICHERS } from "../../src/world/pipeline/enrichers";
import { MAX_CARD_RELATIONS, newReadFrame } from "../../src/world/pipeline/frame";
import { readWorldCard, readWorldMatches } from "../../src/world/pipeline/read";
import { worldNamespace } from "../../src/world/references";
import { validEvent } from "../fixtures";
import { artifactFixture } from "../helpers/artifact-fixture";
import { testClock } from "../helpers/clock";
import { enrollSource, worldSeed } from "../helpers/world-seed";
import { cardFixture } from "./card-fixture";

setDefaultTimeout(120_000);

/** The shipped vocabulary with one kind switched off for the extraction model. */
function withoutProducer(id: string): ReturnType<typeof createWorldRegistry> {
  const modules: WorldVocabularyModule[] = WORLD_VOCABULARY_MODULES.map((module) =>
    module.kind?.id === id ? { ...module, kind: { ...module.kind, offeredToProducer: false } } : module,
  );
  return createWorldRegistry(modules);
}

const ownerCtx = (db: ReturnType<typeof openLedger>): ServeContext => ({ db, vaultPath: "/tmp/world-population", principal: OWNER });

function find(ctx: ServeContext, operation: "find_concepts" | "find_situations", label: string) {
  const { data } = serveWorldView(ctx, { operation, label, valid: { kind: "all" }, knownAt: { kind: "current" } });
  if (!("result" in data) || data.result.status === "unavailable") throw new Error("discovery unavailable");
  const page = data.result.data as unknown as { matches: unknown[]; coverage: { status: string; gaps: string[] } };
  return { status: data.result.status, matches: page.matches.length, coverage: page.coverage };
}

test("an empty page for a kind nothing can populate is partial with the gap coverage", () => {
  const db = openLedger(":memory:");
  try {
    const ctx = ownerCtx(db);
    expect(find(ctx, "find_situations", "")).toMatchObject({
      status: "current",
      matches: 0,
      coverage: { status: "complete_for_query", gaps: [] },
    });
    const dark = withWorldRegistry(withoutProducer("situation"), () => find(ctx, "find_situations", ""));
    expect(dark.status).toBe("incomplete");
    expect(dark.matches).toBe(0);
    expect(dark.coverage.status).toBe("partial");
    expect(dark.coverage.gaps).toEqual(["coverage"]);
    const offered = withWorldRegistry(withoutProducer("situation"), () => find(ctx, "find_concepts", ""));
    expect(offered.status).toBe("current");
    expect(offered.coverage.gaps).toEqual([]);
  } finally {
    db.close();
  }
});

test("a kind that has claims is not called dark, whatever the label filter leaves", async () => {
  const db = openLedger(":memory:");
  try {
    const ctx = ownerCtx(db);
    await worldSeed(db, { kind: "situation", subject: "project:launch", label: "Launch plan", discover: false });
    withWorldRegistry(withoutProducer("situation"), () => {
      expect(find(ctx, "find_situations", "Launch")).toMatchObject({ status: "current", matches: 1 });
      expect(find(ctx, "find_situations", "zzzz")).toMatchObject({
        status: "current",
        matches: 0,
        coverage: { status: "complete_for_query", gaps: [] },
      });
    });
  } finally {
    db.close();
  }
});

test("a kind hidden from the reader by its grant reads as empty, not as populated", async () => {
  const db = openLedger(":memory:");
  try {
    await worldSeed(db, { kind: "situation", subject: "project:secret", label: "Secret plan", floor: "private", discover: false });
    const agent = addAgent(db, "narrow", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["project:other"] });
    const principal = authenticate(db, agent.token);
    if (principal === null) throw new Error("the narrow reader did not authenticate");
    const dark = withWorldRegistry(withoutProducer("situation"), () =>
      find({ db, vaultPath: "/tmp/world-population", principal }, "find_situations", ""),
    );
    expect(dark).toMatchObject({ status: "incomplete", matches: 0, coverage: { status: "partial", gaps: ["coverage"] } });
  } finally {
    db.close();
  }
});

test("a scanned classification with invalid support does not populate a dark kind", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db, { kind: "situation", discover: false });
    db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.semantic.polarity','negative') WHERE claim_id=?")
      .run(seed.claims[0]!);
    const result = withWorldRegistry(withoutProducer("situation"), () => find(ownerCtx(db), "find_situations", ""));
    expect(result).toMatchObject({ status: "incomplete", matches: 0, coverage: { status: "partial", gaps: ["coverage"] } });
  } finally {
    db.close();
  }
});

for (const restriction of [
  { name: "claim type", grant: { types: ["note"] }, asserted: "2026-02-28T10:30:00Z" },
  { name: "asserted since", grant: { since: "2026-02-28T10:30:00Z" }, asserted: "2026-01-01T00:00:00Z" },
  { name: "asserted until", grant: { until: "2026-02-28T10:30:00Z" }, asserted: "2026-04-01T00:00:00Z" },
]) {
  for (const kind of ["concept", "situation"] as const) {
    test(`${kind} denied by ${restriction.name} cannot populate a dark kind or move work counters`, async () => {
      const db = openLedger(":memory:");
      try {
        const agent = addAgent(db, "restricted-reader", { ...OWNER_AGENT_GRANT, ...restriction.grant });
        const principal = authenticate(db, agent.token)!;
        const ctx = { ...ownerCtx(db), principal };
        const read = (label: string) => collectReadFrames(() =>
          withWorldRegistry(withoutProducer(kind), () => find(ctx, `find_${kind}s`, label)),
        );
        const before = read("");
        const seed = await worldSeed(db, {
          kind, subject: "topic:restricted", label: "Restricted label",
          clock: testClock(restriction.asserted), discover: false,
        });
        for (const label of ["", "Restricted", "absent"]) {
          const after = read(label);
          expect(after.result).toEqual(before.result);
          expect(after.frames.map((frame) => frame.stats)).toEqual([{ rowsExamined: 0, claimsVerified: 0 }]);
        }
        db.query("UPDATE claims SET status='reverted' WHERE claim_id IN (SELECT value FROM json_each(?))")
          .run(JSON.stringify(seed.claims));
        const reverted = read("");
        expect(reverted.result).toEqual(before.result);
        expect(reverted.frames.map((frame) => frame.stats)).toEqual(before.frames.map((frame) => frame.stats));
      } finally {
        db.close();
      }
    });
  }
}

test("asserted-time bounds are inclusive and denied labels cannot consume candidate limits", async () => {
  const db = openLedger(":memory:");
  try {
    const at = "2026-02-28T10:30:00Z";
    const seed = await worldSeed(db, {
      label: "Visible label", clock: testClock(at), discover: false,
      predicates: Array.from({ length: 140 }, (_, index) => ({
        predicate: "concept.label", object: { kind: "literal" as const, value: `Denied label ${index}` },
      })),
    });
    const denied = JSON.stringify(seed.claims.slice(2));
    db.query("UPDATE claims SET asserted_at='2026-01-01T00:00:00Z',status='reverted' WHERE claim_id IN (SELECT value FROM json_each(?))")
      .run(denied);
    const agent = addAgent(db, "bounded-reader", {
      ...OWNER_AGENT_GRANT, types: ["note", "claim"], since: at, until: at,
    });
    const ctx = { ...ownerCtx(db), principal: authenticate(db, agent.token)! };
    const read = () => collectReadFrames(() => find(ctx, "find_concepts", "Visible"));
    const before = read();
    expect(before.result).toMatchObject({ status: "current", matches: 1, coverage: { gaps: [] } });
    db.query("UPDATE claims SET status='live' WHERE claim_id IN (SELECT value FROM json_each(?))").run(denied);
    const after = read();
    expect(after.result).toEqual(before.result);
    expect(after.frames[0]!.stats).toEqual(before.frames[0]!.stats);
  } finally {
    db.close();
  }
});

const EXTRACTION_NINE_SEEDS: readonly {
  readonly kind: Exclude<(typeof ALL_WORLD_KINDS)[number], "artifact_version">;
  readonly subject: string;
  readonly label: string;
}[] = [
  { kind: "concept", subject: "topic:ten-concept", label: "Calibration" },
  { kind: "situation", subject: "project:ten-situation", label: "Launch readiness" },
  { kind: "person", subject: "person:ten-ada", label: "Ada Lovelace" },
  { kind: "question", subject: "question:ten-q1", label: "How should we calibrate priors?" },
  { kind: "procedure", subject: "procedure:ten-p1", label: "Pre-release inspection" },
  { kind: "skill", subject: "skill:ten-s1", label: "Root cause triage" },
  { kind: "framework", subject: "framework:ten-f1", label: "Reliability review" },
  { kind: "commitment", subject: "commitment:ten-c1", label: "Deliver release checklist" },
  { kind: "decision", subject: "decision:ten-d1", label: "Adopt strict verification" },
];

/** Populate one extraction kind through the real v2 draft grounding and writer seam on WORLD_REGISTRY. */
async function admitExtractedKind(
  db: ReturnType<typeof openLedger>,
  sourceKey: string,
  item: (typeof EXTRACTION_NINE_SEEDS)[number],
): Promise<string[]> {
  const spec = WORLD_REGISTRY.kind(item.kind)!;
  const text = `${item.label} is evidenced in this synthetic extraction record.`;
  const stored = accept(
    db,
    {
      ...validEvent(),
      connector_id: "world.extract-fixture",
      source_record_id: ulid(),
      text,
      sensitivity_hint: "public",
      subjects: [{ subject_id: item.subject, role: "about" }],
    },
    { source: { source_key: sourceKey, expected_revision: 1 } },
  );
  if (stored.status !== "stored") throw new Error(`event store failed for ${item.kind}`);
  const event = stored.event;
  const acceptedAt = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(event.event_id)!.accepted_at;
  const span = { event_id: event.event_id, start_utf16: 0, end_utf16: item.label.length };
  const ref = { kind: "supplied" as const, id: item.subject, namespace: { connector_id: "world.extract-fixture", source_key: sourceKey } };
  const input: ProduceInputV2 = {
    events: [{ event_id: event.event_id, text }],
    supplied_refs: [{ id: "s1", anchors: [span] }],
    vocabulary_refs: [spec.vocabularyId],
    predicates: [
      { id: "world.kind", object_kinds: ["vocabulary"] },
      { id: spec.labelPredicate, object_kinds: ["literal"] },
    ],
    budget: { max_calls: 1, max_input_tokens: 1000, max_output_tokens: 1000 },
  };
  const claims: RichClaimDraft[] = [
    {
      id: "c-kind",
      subject: { kind: "supplied", id: "s1" },
      predicate: "world.kind",
      object: { kind: "vocabulary", ref: { kind: "vocabulary", id: spec.vocabularyId } },
      perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
      context: [],
      polarity: "positive",
      body: `${item.label} is a ${item.kind}.`,
      valid_from: null,
      valid_to: null,
      temporal_basis: "unknown",
      confidence: 0.9,
      sensitivity: "public",
      anchors: [span],
    },
    {
      id: "c-label",
      subject: { kind: "supplied", id: "s1" },
      predicate: spec.labelPredicate,
      object: { kind: "literal", value: item.label },
      perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
      context: [],
      polarity: "positive",
      body: item.label,
      valid_from: null,
      valid_to: null,
      temporal_basis: "unknown",
      confidence: 0.9,
      sensitivity: "public",
      anchors: [span],
    },
  ];
  const prepared = prepareWorldDrafts({ schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [], claims }, input, {
    events: [{ ...event, accepted_at: acceptedAt, source_key: sourceKey, subjects: [ref] }],
    supplied_refs: new Map([["s1", ref]]),
    model_ref: "synthetic-extract-v2",
  });
  expect(prepared.dropped).toEqual([]);
  expect(prepared.drafts).toHaveLength(2);
  const claimIds: string[] = [];
  for (const draft of prepared.drafts) {
    const res = await insertClaim({ db }, draft);
    if (res.outcome !== "stored" && res.outcome !== "duplicate") throw new Error(`insertClaim failed for ${item.kind}`);
    claimIds.push(res.claim.claim_id);
  }
  return claimIds;
}

test("all ten world kinds populate through the real extraction draft path on WORLD_REGISTRY", async () => {
  expect([...WORLD_REGISTRY.kinds.map((k) => k.id)].sort()).toEqual([...ALL_WORLD_KINDS].sort());
  expect(TYPED_EXTRACTION_KINDS).toHaveLength(7);
  expect(COLLECTORS).toContain(typedKindStatements);
  expect(ENRICHERS).toContain(kindQualificationEnricher);
  expect(ENRICHERS).toContain(conflictEnricher);
  expect(ENRICHERS).toContain(procedureEnricher);

  const db = openLedger(":memory:");
  let artifacts: Awaited<ReturnType<typeof artifactFixture>> | undefined;
  try {
    const empty = inspectWorldKindCoverage(db);
    expect(empty.total_kinds).toBe(10);
    expect(empty.active_kinds).toBe(3);
    expect(empty.populated_kinds).toBe(0);
    expect(empty.offered_kinds).toBe(2);
    for (const kind of TYPED_EXTRACTION_KINDS) {
      const entry = empty.kinds.find((item) => item.kind === kind)!;
      expect(entry.state).toBe("dark");
      expect(entry.gaps).toEqual(["coverage"]);
      expect(entry.classified_handles).toBe(0);
      expect(entry.live_assertions).toBe(0);
    }

    // Populate all 9 extraction kinds through prepareWorldDrafts -> insertClaim on the real WORLD_REGISTRY,
    // plus connector-captured artifact_version for 10/10 populated and active kinds.
    const sourceKey = enrollSource(db, "world.extract-fixture", "public");
    for (const item of EXTRACTION_NINE_SEEDS) {
      await admitExtractedKind(db, sourceKey, item);
    }
    artifacts = await artifactFixture(db);
    const captured = await artifacts.capture("Synthetic release artifact bytes.");
    const populated = inspectWorldKindCoverage(db);
    expect(populated.total_kinds).toBe(10);
    expect(populated.active_kinds).toBe(10);
    expect(populated.populated_kinds).toBe(10);
    for (const entry of populated.kinds) {
      expect(entry.state).toBe("active");
      expect(entry.classified_handles).toBe(1);
      expect(entry.live_assertions).toBeGreaterThanOrEqual(2);
      expect(entry.contributing_sources).toBe(1);
      expect(entry.gaps).toEqual([]);
    }
    const ctx = ownerCtx(db);
    db.transaction(() => {
      const ns = worldNamespace(db, OWNER);
      for (const item of EXTRACTION_NINE_SEEDS) {
        const page = readWorldMatches(newReadFrame(ctx, ns, { kind: "all" }), item.kind, item.label, null, 100);
        expect(page.matches).toHaveLength(1);
        expect(page.matches[0]!.labels).toEqual([item.label]);
        expect(page.coverage).toMatchObject({ status: "complete_for_query", gaps: [] });
      }
      const artifactPage = readWorldMatches(newReadFrame(ctx, ns, { kind: "all" }), "artifact_version", captured.metadata.sha256.slice(0, 12), null, 100);
      expect(artifactPage.matches).toHaveLength(1);
      expect(artifactPage.coverage).toMatchObject({ status: "complete_for_query", gaps: [] });
    }).immediate();
  } finally {
    artifacts?.dispose();
    db.close();
  }
});

test("tampered support admissions cannot activate dark kinds or inflate live_assertions in coverage", async () => {
  const db = openLedger(":memory:");
  try {
    // 1. Tampered world.kind admission cannot classify a handle or activate a dark kind.
    for (const kind of TYPED_EXTRACTION_KINDS) {
      const seed = await worldSeed(db, {
        kind,
        subject: `${kind}:tampered-kind`,
        label: `Tampered ${kind}`,
        discover: false,
      });
      db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.semantic.polarity','negative') WHERE claim_id=?")
        .run(seed.claims[0]!);
    }
    const darkReport = readWorldKindCoverage(ownerCtx(db));
    for (const kind of TYPED_EXTRACTION_KINDS) {
      const entry = darkReport.kinds.find((item) => item.kind === kind)!;
      expect(entry.classified_handles).toBe(0);
      expect(entry.live_assertions).toBe(0);
      expect(entry.state).toBe("dark");
      expect(entry.gaps).toEqual(["coverage"]);
    }

    // 2. Tampered non-classification assertion on a validly classified handle must be excluded from live_assertions.
    const validSeed = await worldSeed(db, {
      kind: "question",
      subject: "question:valid-handle",
      label: "Valid handle question",
      predicates: [
        { predicate: "question.status", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/open" } } },
      ],
      discover: false,
    });
    const before = readWorldKindCoverage(ownerCtx(db)).kinds.find((item) => item.kind === "question")!;
    expect(before.classified_handles).toBe(1);
    expect(before.live_assertions).toBe(3);

    db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.semantic.polarity','negative') WHERE claim_id=?")
      .run(validSeed.claims[2]!);
    const after = readWorldKindCoverage(ownerCtx(db)).kinds.find((item) => item.kind === "question")!;
    expect(after.classified_handles).toBe(1);
    expect(after.live_assertions).toBe(2);
    expect(after.state).toBe("active");
  } finally {
    db.close();
  }
});

test("registered COLLECTORS gather context claims across all 7 kinds, enforce history coverage, and report overflow", async () => {
  const f = await cardFixture();
  try {
    const contextKinds = ["question", "procedure", "skill", "framework", "commitment", "decision"] as const;
    const handles = new Map<string, string>();
    const contextClaims = new Map<string, string>();

    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/person" } }, { subject: "person:ada" });
    await f.write("person.label", { kind: "literal", value: "Ada" }, { subject: "person:ada" });
    const personNote = await f.write("concept.example", { kind: "literal", value: "Ada contextual note" }, {
      subject: "topic:bayes", speaker: "person:ada", mode: "quoted", context: ["person:ada"],
    });
    if (personNote.stored.outcome !== "stored" && personNote.stored.outcome !== "duplicate") throw new Error("person context claim failed");
    handles.set("person", f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get("person:ada")!.handle_id);
    contextClaims.set("person", personNote.stored.claim.claim_id);

    for (const kind of contextKinds) {
      const subject = `${kind}:ctx-target`;
      await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: `world/${kind}` } }, { subject });
      const labelPred = WORLD_REGISTRY.kind(kind)!.labelPredicate;
      await f.write(labelPred, { kind: "literal", value: `Target ${kind}` }, { subject });
      const linked = await f.write("concept.example", { kind: "literal", value: `Linked evidence for ${kind}` }, {
        subject: "topic:bayes", context: [subject],
      });
      if (linked.stored.outcome !== "stored" && linked.stored.outcome !== "duplicate") throw new Error(`${kind} context claim failed`);
      handles.set(kind, f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get(subject)!.handle_id);
      contextClaims.set(kind, linked.stored.claim.claim_id);
    }

    // Collect directly through the production COLLECTORS list (no test-only pipeline override).
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      for (const kind of TYPED_EXTRACTION_KINDS) {
        const spec = WORLD_REGISTRY.kind(kind)!;
        const handle = handles.get(kind)!;
        const frame = newReadFrame(f.ctx, ns, { kind: "all" });
        const collected = collectCard(frame, { anchor: handle, members: [handle], resolution: "distinct" }, spec, COLLECTORS)!;
        expect(collected.items.map((item) => item.claimId)).toContain(contextClaims.get(kind)!);
        expect(collected.overflow).toBe(false);
        expect(TYPED_KIND_COLLECTORS[kind](frame, { anchor: handle, members: [handle], resolution: "distinct" }, WORLD_REGISTRY.kind("concept")!)).toEqual([]);
      }
    }).immediate();

    // Historical cutoff without coverage row throws WorldHistoryUnavailable; baseline_only flags historyBaseline.
    const questionHandle = handles.get("question")!;
    const questionClaimId = contextClaims.get("question")!;
    const questionSpec = WORLD_REGISTRY.kind("question")!;
    const maxSeq = f.db.query<{ seq: number }, []>("SELECT coalesce(max(sequence), 1) AS seq FROM claim_lifecycle_history").get()!.seq;
    f.db.query("DELETE FROM claim_history_coverage WHERE claim_id=?").run(questionClaimId);
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      const missingFrame = newReadFrame(f.ctx, ns, { kind: "all" }, undefined, { kind: "recorded", at: "2030-01-01T00:00:00Z", sequence: maxSeq });
      expect(() => collectCard(missingFrame, { anchor: questionHandle, members: [questionHandle], resolution: "distinct" }, questionSpec, COLLECTORS))
        .toThrow(WorldHistoryUnavailable);
    }).immediate();

    f.db.query("INSERT INTO claim_history_coverage (claim_id, coverage, complete_from_sequence) VALUES (?, 'baseline_only', 1)").run(questionClaimId);
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      const baselineFrame = newReadFrame(f.ctx, ns, { kind: "all" }, undefined, { kind: "recorded", at: "2030-01-01T00:00:00Z", sequence: maxSeq });
      const baselineCollected = collectCard(baselineFrame, { anchor: questionHandle, members: [questionHandle], resolution: "distinct" }, questionSpec, COLLECTORS)!;
      expect(baselineCollected.items.map((item) => item.claimId)).toContain(questionClaimId);
      expect(baselineFrame.historyBaseline).toBe(true);
    }).immediate();

    // Overflow bound: >MAX_CARD_RELATIONS context claims triggers collectorOverflow -> collectCard overflow,
    // even when one candidate fails support verification so fewer than MAX_CARD_RELATIONS items remain eligible.
    const overflowSubject = "question:ctx-overflow";
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/question" } }, { subject: overflowSubject });
    await f.write("question.text", { kind: "literal", value: "Overflow question" }, { subject: overflowSubject });
    const contextIds: string[] = [];
    for (let i = 0; i < MAX_CARD_RELATIONS + 2; i += 1) {
      const res = await f.write("concept.example", { kind: "literal", value: `Context claim ${i}` }, {
        subject: "topic:bayes", context: [overflowSubject],
      });
      if (res.stored.outcome !== "stored" && res.stored.outcome !== "duplicate") throw new Error("overflow context claim failed");
      contextIds.push(res.stored.claim.claim_id);
    }
    // Tamper 5 context claims so eligible items stay < MAX_CARD_RELATIONS while SQL still hits MAX_CARD_RELATIONS + 1.
    for (const badId of contextIds.slice(0, 5)) {
      f.db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.semantic.polarity','negative') WHERE claim_id=?").run(badId);
    }
    const overflowHandle = f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get(overflowSubject)!.handle_id;
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      const frame = newReadFrame(f.ctx, ns, { kind: "all" });
      const collected = collectCard(frame, { anchor: overflowHandle, members: [overflowHandle], resolution: "distinct" }, questionSpec, COLLECTORS)!;
      expect(collected.overflow).toBe(true);
      expect(frame.collectorOverflow).toBe(false);
    }).immediate();
    // Concept member collection only reports overflow when >MAX_CARD_RELATIONS claims pass verification;
    // ineligible SQL rows dropped by verifyClaim must not cause false overflow on concept cards.
    const conceptNoOverflow = "topic:no-false-overflow";
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }, { subject: conceptNoOverflow });
    await f.write("concept.label", { kind: "literal", value: "No False Overflow" }, { subject: conceptNoOverflow });
    const conceptExampleIds: string[] = [];
    for (let i = 0; i < MAX_CARD_RELATIONS - 1; i += 1) {
      const res = await f.write("concept.example", { kind: "literal", value: `Example ${i}` }, { subject: conceptNoOverflow });
      if (res.stored.outcome !== "stored" && res.stored.outcome !== "duplicate") throw new Error("concept example failed");
      conceptExampleIds.push(res.stored.claim.claim_id);
    }
    // 129 raw SQL rows total (kind + label + 127 examples), with 2 examples tampered so 127 claims pass verification.
    for (const badId of conceptExampleIds.slice(0, 2)) {
      f.db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.semantic.polarity','negative') WHERE claim_id=?").run(badId);
    }
    const conceptHandle = f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get(conceptNoOverflow)!.handle_id;
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      const frame = newReadFrame(f.ctx, ns, { kind: "all" });
      const collected = collectCard(frame, { anchor: conceptHandle, members: [conceptHandle], resolution: "distinct" }, WORLD_REGISTRY.kind("concept")!, COLLECTORS)!;
      expect(collected.items).toHaveLength(MAX_CARD_RELATIONS - 1);
      expect(collected.overflow).toBe(false);
    }).immediate();
  } finally {
    f.dispose();
  }
});

test("registered ENRICHERS detect overlapping status conflicts, allow non-overlapping status history, and guard person grounding", async () => {
  for (const predicate of [
    "concept.definition", "learning.assistance", "question.status", "commitment.status", "decision.status", "framework.lifecycle",
  ]) {
    expect(isSingleValuedWorldPredicate(predicate)).toBe(true);
  }
  for (const predicate of ["person.role", "question.candidate_answer", "concept.example"]) {
    expect(isSingleValuedWorldPredicate(predicate)).toBe(false);
  }

  const f = await cardFixture();
  try {
    // 1. Overlapping positive statuses conflict through the real readWorldCard / ENRICHERS pipeline.
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/question" } }, { subject: "question:c1" });
    await f.write("question.text", { kind: "literal", value: "Competing question" }, { subject: "question:c1" });
    await f.write("question.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/open" } }, { subject: "question:c1" });
    await f.write("question.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/resolved" } }, { subject: "question:c1" });

    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/framework" } }, { subject: "framework:c1" });
    await f.write("framework.label", { kind: "literal", value: "Competing framework" }, { subject: "framework:c1" });
    await f.write("framework.lifecycle", { kind: "vocabulary", ref: { kind: "vocabulary", id: "framework/adopted" } }, { subject: "framework:c1" });
    await f.write("framework.lifecycle", { kind: "vocabulary", ref: { kind: "vocabulary", id: "framework/rejected" } }, { subject: "framework:c1" });

    const qHandle = f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get("question:c1")!.handle_id;
    const fHandle = f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get("framework:c1")!.handle_id;
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      const qCard = readWorldCard(newReadFrame(f.ctx, ns, { kind: "all" }), qHandle, "question") as QuestionCard | null;
      if (qCard === null || qCard.schema !== "kizuki.question-card/v1") throw new Error("question card missing");
      expect(qCard.statusEvidence).toHaveLength(2);
      expect(qCard.statusEvidence.every((r) => r.conflict === "present")).toBe(true);

      const fwCard = readWorldCard(newReadFrame(f.ctx, ns, { kind: "all" }), fHandle, "framework") as FrameworkCard | null;
      if (fwCard === null || fwCard.schema !== "kizuki.framework-card/v1") throw new Error("framework card missing");
      expect(fwCard.lifecycle).toHaveLength(2);
      expect(fwCard.lifecycle.every((r) => r.conflict === "present")).toBe(true);
    }).immediate();

    // 2. Legitimate non-overlapping question.status and commitment.status histories are NOT marked as conflicts.
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/question" } }, { subject: "question:hist" });
    await f.write("question.text", { kind: "literal", value: "Historical question" }, { subject: "question:hist" });
    await f.write("question.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/open" } }, {
      subject: "question:hist", from: "2025-01-01T00:00:00Z", until: "2026-01-01T00:00:00Z",
    });
    await f.write("question.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/resolved" } }, {
      subject: "question:hist", from: "2026-01-01T00:00:00Z", until: null,
    });

    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject: "project:hist-sit" });
    await f.write("situation.label", { kind: "literal", value: "History situation" }, { subject: "project:hist-sit" });
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/commitment" } }, { subject: "commitment:hist" });
    await f.write("commitment.label", { kind: "literal", value: "Historical commitment" }, { subject: "commitment:hist" });
    await f.write("situation.has_commitment", { kind: "subject", ref: f.ref("commitment:hist") }, { subject: "project:hist-sit" });
    await f.write("commitment.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "commitment/open" } }, {
      subject: "commitment:hist", from: "2025-01-01T00:00:00Z", until: "2026-01-01T00:00:00Z",
    });
    await f.write("commitment.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "commitment/done" } }, {
      subject: "commitment:hist", from: "2026-01-01T00:00:00Z", until: null,
    });

    const qHistHandle = f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get("question:hist")!.handle_id;
    const sitHistHandle = f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get("project:hist-sit")!.handle_id;
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      const qHistCard = readWorldCard(newReadFrame(f.ctx, ns, { kind: "all" }), qHistHandle, "question") as QuestionCard | null;
      if (qHistCard === null || qHistCard.schema !== "kizuki.question-card/v1") throw new Error("question history card missing");
      expect(qHistCard.statusEvidence).toHaveLength(2);
      expect(qHistCard.statusEvidence.map((r) => r.conflict)).toEqual(["none_observed", "none_observed"]);

      const sitCard = readWorldCard(newReadFrame(f.ctx, ns, { kind: "all" }), sitHistHandle, "situation", "kizuki.situation-card/v2") as SituationCardV2 | null;
      if (sitCard === null || sitCard.schema !== "kizuki.situation-card/v2") throw new Error("situation v2 history card missing");
      const histStatuses = sitCard.uncertainty.filter((r) => r.predicate === "commitment.status");
      expect(histStatuses).toHaveLength(2);
      expect(histStatuses.map((r) => r.conflict)).toEqual(["none_observed", "none_observed"]);
    }).immediate();

    // 3. Owner correction replacing question.status keeps conflict none_observed.
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/question" } }, { subject: "question:corr" });
    await f.write("question.text", { kind: "literal", value: "Corrected question" }, { subject: "question:corr" });
    await f.write("question.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/open" } }, { subject: "question:corr" });
    const qCorrFound = serveWorldView(f.ctx, { operation: "find_questions", label: "Corrected question", valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
    if (!("result" in qCorrFound) || !("data" in qCorrFound.result) || !("matches" in qCorrFound.result.data)) throw new Error("corrected question missing");
    const qCorrRef = qCorrFound.result.data.matches[0]!.ref;
    const qCorrBefore = serveWorldView(f.ctx, { operation: "question", question: qCorrRef, valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
    if (!("result" in qCorrBefore) || !("data" in qCorrBefore.result) || qCorrBefore.result.data.schema !== "kizuki.question-card/v1") throw new Error("question card missing");
    await serveCorrect(f.ctx, {
      statement: "Resolved now.",
      target: { world_claim: qCorrBefore.result.data.statusEvidence[0]!.claim },
      mode: "replace_object",
      object: { kind: "vocabulary", id: "question/resolved" },
    });
    const qCorrAfter = serveWorldView(f.ctx, { operation: "question", question: qCorrRef, valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
    if (!("result" in qCorrAfter) || !("data" in qCorrAfter.result) || qCorrAfter.result.data.schema !== "kizuki.question-card/v1") throw new Error("question card after correction missing");
    expect(qCorrAfter.result.data.statusEvidence).toHaveLength(1);
    expect(qCorrAfter.result.data.statusEvidence[0]!.conflict).toBe("none_observed");

    // 4. Multi-valued person.role stays non-conflicting for distinct positive values through real readWorldCard,
    // and kindQualificationEnricher flags non-supplied person classifications with a coverage gap.
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/person" } }, { subject: "person:multi" });
    await f.write("person.label", { kind: "literal", value: "Multi Role" }, { subject: "person:multi" });
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: "person:multi" });
    await f.write("person.role", { kind: "literal", value: "Editor" }, { subject: "person:multi" });
    const personHandle = f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get("person:multi")!.handle_id;
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      const personFrame = newReadFrame(f.ctx, ns, { kind: "all" });
      const personCard = readWorldCard(personFrame, personHandle, "person") as PersonCard | null;
      if (personCard === null || personCard.schema !== "kizuki.person-card/v1") throw new Error("person card missing");
      expect(personCard.roles.map((r) => r.conflict)).toEqual(["none_observed", "none_observed"]);
      expect(personCard.coverage.gaps).not.toContain("coverage");

      // Simulate a restored non-supplied person classification reaching kindQualificationEnricher.
      const collected = collectCard(personFrame, { anchor: personHandle, members: [personHandle], resolution: "distinct" }, WORLD_REGISTRY.kind("person")!, COLLECTORS)!;
      const badKind = collected.classification[0]!;
      const body = kindQualificationEnricher(personFrame, {
        claims: [{
          eligible: { ...badKind, semantic: { ...badKind.semantic, subject: { kind: "occurrence", id: "occ-legacy" } } },
          relation: personCard.roles[0]!,
        }],
        gaps: [],
        summary: null,
      });
      expect(body.gaps).toEqual(["coverage"]);
    }).immediate();
  } finally {
    f.dispose();
  }
});
