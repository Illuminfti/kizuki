/**
 * Discovery must not call a kind complete when nothing can populate it. A kind
 * that is registered, reachable only by extraction, and not offered to the
 * extraction model has no claims by design; an empty page for it is partial
 * with the gap `coverage`, never `complete_for_query`.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { createWorldRegistry, type WorldVocabularyModule } from "../../src/contracts/world-kinds";
import { WORLD_REGISTRY, WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import { openLedger } from "../../src/ledger/db";
import { serveWorldView } from "@kizuki/core/world";
import type { ServeContext } from "../../src/serving/types";
import { collectReadFrames, withWorldPipeline } from "@kizuki/core/testing";
import {
  ALL_WORLD_KINDS,
  TYPED_EXTRACTION_KINDS,
  TYPED_KIND_COLLECTORS,
  typedKindStatements,
} from "../../src/world/collectors";
import {
  SINGLE_VALUED_WORLD_PREDICATES,
  conflictEnricher,
  independenceEnricher,
  kindQualificationEnricher,
  procedureEnricher,
  summarizeKindQualification,
} from "../../src/world/enrich";
import { inspectWorldKindCoverage, readWorldKindCoverage } from "../../src/world/coverage";
import { WorldHistoryUnavailable } from "../../src/world/known/cutoff";
import { collectCard } from "../../src/world/pipeline/collect";
import { enrich } from "../../src/world/pipeline/enrich";
import { newReadFrame } from "../../src/world/pipeline/frame";
import { readWorldMatches } from "../../src/world/pipeline/read";
import { worldNamespace } from "../../src/world/references";
import { artifactFixture } from "../helpers/artifact-fixture";
import { testClock } from "../helpers/clock";
import { worldSeed } from "../helpers/world-seed";
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

/** Test registry with all extraction-populated world kinds enabled for producer population checks. */
function withAllKindsOffered(): ReturnType<typeof createWorldRegistry> {
  const modules: WorldVocabularyModule[] = WORLD_VOCABULARY_MODULES.map((module) =>
    module.kind !== null && module.kind.population.includes("extraction")
      ? { ...module, kind: { ...module.kind, offeredToProducer: true } }
      : module,
  );
  return createWorldRegistry(modules);
}

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

test("all ten world kinds are registered and coverage reports dark vs active transitions accurately", async () => {
  expect([...WORLD_REGISTRY.kinds.map((k) => k.id)].sort()).toEqual([...ALL_WORLD_KINDS].sort());
  expect(TYPED_EXTRACTION_KINDS).toHaveLength(7);

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
    }

    // With all extraction kinds enabled in an isolated test registry, 10/10 kinds are active even when empty.
    withWorldRegistry(withAllKindsOffered(), () => {
      const enabled = inspectWorldKindCoverage(db);
      expect(enabled.total_kinds).toBe(10);
      expect(enabled.active_kinds).toBe(10);
      expect(enabled.offered_kinds).toBe(9);
      for (const entry of enabled.kinds) {
        expect(entry.state).toBe("active");
        expect(entry.gaps).toEqual([]);
      }
      const ctx = ownerCtx(db);
      db.transaction(() => {
        const ns = worldNamespace(db, OWNER);
        for (const kind of ALL_WORLD_KINDS) {
          const page = readWorldMatches(newReadFrame(ctx, ns, { kind: "all" }), kind, "", null, 100);
          expect(page.coverage).toMatchObject({ status: "complete_for_query", gaps: [] });
        }
      }).immediate();
    });

    // Populating all 10 kinds (9 extraction kinds + connector-captured artifact_version) activates 10/10 kinds.
    for (const item of EXTRACTION_NINE_SEEDS) {
      await worldSeed(db, { kind: item.kind, subject: item.subject, label: item.label, discover: false });
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

test("tampered support admissions cannot activate dark typed extraction kinds in coverage", async () => {
  const db = openLedger(":memory:");
  try {
    for (const kind of ["question", "commitment", "decision", "procedure", "skill", "framework", "person"] as const) {
      const seed = await worldSeed(db, {
        kind,
        subject: `${kind}:tampered`,
        label: `Tampered ${kind}`,
        discover: false,
      });
      db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.semantic.polarity','negative') WHERE claim_id=?")
        .run(seed.claims[0]!);
    }
    const report = readWorldKindCoverage(ownerCtx(db));
    for (const kind of TYPED_EXTRACTION_KINDS) {
      const entry = report.kinds.find((item) => item.kind === kind)!;
      expect(entry.classified_handles).toBe(0);
      expect(entry.state).toBe("dark");
      expect(entry.gaps).toEqual(["coverage"]);
    }
  } finally {
    db.close();
  }
});

test("typed kind collectors gather authorized context claims across all 7 kinds and enforce history coverage", async () => {
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

    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      for (const kind of TYPED_EXTRACTION_KINDS) {
        const spec = WORLD_REGISTRY.kind(kind)!;
        const handle = handles.get(kind)!;
        const frame = newReadFrame(f.ctx, ns, { kind: "all" });
        const ids = TYPED_KIND_COLLECTORS[kind](frame, { anchor: handle, members: [handle], resolution: "distinct" }, spec);
        expect(ids).toContain(contextClaims.get(kind)!);
        expect(typedKindStatements(frame, { anchor: handle, members: [handle], resolution: "distinct" }, spec)).toEqual(ids);
        // Mismatched kind returns empty.
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
      expect(() => typedKindStatements(missingFrame, { anchor: questionHandle, members: [questionHandle], resolution: "distinct" }, questionSpec))
        .toThrow(WorldHistoryUnavailable);
    }).immediate();

    f.db.query("INSERT INTO claim_history_coverage (claim_id, coverage, complete_from_sequence) VALUES (?, 'baseline_only', 1)").run(questionClaimId);
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      const baselineFrame = newReadFrame(f.ctx, ns, { kind: "all" }, undefined, { kind: "recorded", at: "2030-01-01T00:00:00Z", sequence: maxSeq });
      const baselineIds = typedKindStatements(baselineFrame, { anchor: questionHandle, members: [questionHandle], resolution: "distinct" }, questionSpec);
      expect(baselineIds).toContain(questionClaimId);
      expect(baselineFrame.historyBaseline).toBe(true);
    }).immediate();
  } finally {
    f.dispose();
  }
});

test("conflict, procedure, and qualification enrichers cover all 7 typed extraction kinds accurately", async () => {
  expect([...SINGLE_VALUED_WORLD_PREDICATES]).toEqual(expect.arrayContaining([
    "concept.definition", "learning.assistance", "question.status", "commitment.status", "decision.status", "framework.lifecycle",
  ]));

  const f = await cardFixture();
  try {
    // 1. Conflicting single-valued statuses across question, commitment, decision, and framework.
    const conflictCases = [
      { kind: "question", subject: "question:c1", predicate: "question.status", a: "question/open", b: "question/resolved" },
      { kind: "commitment", subject: "commitment:c1", predicate: "commitment.status", a: "commitment/open", b: "commitment/dropped" },
      { kind: "decision", subject: "decision:c1", predicate: "decision.status", a: "decision/decided", b: "decision/reversed" },
      { kind: "framework", subject: "framework:c1", predicate: "framework.lifecycle", a: "framework/adopted", b: "framework/rejected" },
    ] as const;

    for (const item of conflictCases) {
      const spec = WORLD_REGISTRY.kind(item.kind)!;
      await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: spec.vocabularyId } }, { subject: item.subject });
      await f.write(spec.labelPredicate, { kind: "literal", value: `Case ${item.kind}` }, { subject: item.subject });
      await f.write(item.predicate, { kind: "vocabulary", ref: { kind: "vocabulary", id: item.a } }, { subject: item.subject });
      await f.write(item.predicate, { kind: "vocabulary", ref: { kind: "vocabulary", id: item.b } }, { subject: item.subject });

      const handle = f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get(item.subject)!.handle_id;
      f.db.transaction(() => {
        const ns = worldNamespace(f.db, OWNER);
        const frame = newReadFrame(f.ctx, ns, { kind: "all" });
        const collected = collectCard(frame, { anchor: handle, members: [handle], resolution: "distinct" }, spec, [
          (fr, cl, kd) => withWorldPipeline({ collectors: [typedKindStatements] }, () => {
            const all = f.db.query<{ claim_id: string }, [string]>(
              "SELECT claim_id FROM claim_v2_semantics WHERE subject_id=? ORDER BY claim_id",
            ).all(item.subject).map((row) => row.claim_id);
            return [...all, ...typedKindStatements(fr, cl, kd)];
          }),
        ])!;
        const body = enrich(frame, collected.items, [conflictEnricher, independenceEnricher, procedureEnricher, kindQualificationEnricher]);
        const statuses = body.claims.filter((c) => c.relation.predicate === item.predicate);
        expect(statuses).toHaveLength(2);
        expect(statuses.every((c) => c.relation.conflict === "present")).toBe(true);

        const summary = summarizeKindQualification(body);
        expect(summary).toMatchObject({
          kind: item.kind,
          vocabularyId: spec.vocabularyId,
          qualified: true,
          conflictCount: 2,
        });
      }).immediate();
    }

    // 2. Multi-valued person.role stays non-conflicting for distinct positive values, conflicts only on opposite polarity.
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/person" } }, { subject: "person:multi" });
    await f.write("person.label", { kind: "literal", value: "Multi Role" }, { subject: "person:multi" });
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: "person:multi" });
    await f.write("person.role", { kind: "literal", value: "Editor" }, { subject: "person:multi" });
    const personHandle = f.db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get("person:multi")!.handle_id;
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, OWNER);
      const personFrame = newReadFrame(f.ctx, ns, { kind: "all" });
      const personCollected = collectCard(personFrame, { anchor: personHandle, members: [personHandle], resolution: "distinct" }, WORLD_REGISTRY.kind("person")!, [
        () => f.db.query<{ claim_id: string }, [string]>("SELECT claim_id FROM claim_v2_semantics WHERE subject_id=? ORDER BY claim_id").all("person:multi").map((r) => r.claim_id),
      ])!;
      const personBody = enrich(personFrame, personCollected.items, [conflictEnricher, independenceEnricher, kindQualificationEnricher]);
      const roles = personBody.claims.filter((c) => c.relation.predicate === "person.role");
      expect(roles.map((r) => r.relation.conflict)).toEqual(["none_observed", "none_observed"]);
      expect(summarizeKindQualification(personBody)).toMatchObject({
        kind: "person",
        qualified: true,
        requiresSuppliedSubject: true,
        suppliedSubjectValid: true,
        conflictCount: 0,
      });
    }).immediate();
  } finally {
    f.dispose();
  }
});
