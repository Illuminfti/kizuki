import { expect, setSystemTime, test } from "bun:test";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import { getClaim } from "../../src/claims/store";
import type { SituationCardV2 } from "../../src/contracts/situation-card-v2";
import { serveCorrect } from "../../src/serving/correct";
import { serveWorldView } from "../../src/serving/world-view";
import { deliverAttention } from "../../src/world/attention/deliver";
import { setAttentionDisposition } from "../../src/world/attention/state";
import {
  buildCrossDomainLink,
  compileTaskDomainSlice,
  readDomainGraph,
  type TasteRecord,
} from "../../src/world/attention/adaptive-domain";
import {
  canOwnerRetractClaim,
  describeCorrectionSupport,
  isOwnerInterestRetraction,
} from "../../src/world/correction-support";
import {
  effectiveDependencyWeight,
  mergeWorldDependencies,
  recordDependencyWeight,
  worldDependencies,
} from "../../src/world/dependencies";
import { activeWorldOps } from "../../src/world/ops/registry";
import { worldNamespace } from "../../src/world/references";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { budget } from "../canon/helpers";
import { ATTENTION_WHEN } from "../helpers/attention-fixture";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";
import { cardFixture } from "./card-fixture";
import { runBackfill } from "../../src/ingest/run";
import { connector } from "../connections-helpers";
import type { Attention, AttentionCandidate } from "../../src/contracts/attention";
const literal = (value: string) => ({ kind: "literal" as const, value });
const vocabulary = (id: string) => ({ kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id } });

test("commitment cues use exact current deadlines and shared completion; uncertain dates stay quiet", async () => {
  setSystemTime(new Date("2030-01-01T12:00:00.000Z"));
  const f = await cardFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    const complete = () => completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const candidates = () => {
      const body = serveWorldView(f.ctx, { operation: "attention", ...ATTENTION_WHEN }).data;
      if (!("result" in body) || !("data" in body.result)) throw new Error("attention unavailable");
      return (body.result.data as Attention).states.filter((state): state is AttentionCandidate => state.state === "candidate");
    };
    const entries = [];
    for (const [name, dates, status] of [
      ["open", ["2029-12-30"], "open"], ["self-report", ["2029-12-30"], "done"],
      ["future", ["2030-01-03"], "open"], ["conflicting", ["2029-12-29", "2029-12-30"], "open"],
      ["dropped", ["2029-12-30"], "dropped"],
    ] as const) {
      const subject = `commitment:${name}`;
      await f.write("world.kind", vocabulary("world/commitment"), { subject });
      await f.write("commitment.label", literal(name), { subject });
      for (const date of dates) await f.write("commitment.due", literal(date), { subject });
      await f.write("commitment.status", vocabulary(`commitment/${status}`), { subject });
      entries.push({ name, subject });
    }
    await f.write("world.kind", vocabulary("world/situation"), { subject: "situation:deadlines" });
    await f.write("situation.label", literal("Deadline goal"), { subject: "situation:deadlines" });
    await f.write("situation.objective", literal("Finish an independently checked artifact"), { subject: "situation:deadlines" });
    for (const entry of entries) await f.write("situation.has_commitment", { kind: "subject", ref: f.ref(entry.subject) }, { subject: "situation:deadlines" });
    const capture = connector(async () => ({ display: "synthetic" })), manifest = capture.manifest();
    capture.manifest = () => ({ ...manifest, connector_id: "card.fixture", capabilities: { ...manifest.capabilities, backfill: true } });
    capture.backfill = async () => ({ events: [], cursor: "complete", has_more: false });
    expect((await runBackfill(f.db, capture, "card.fixture", f.sourceKey)).errors).toEqual([]);
    await complete();
    const discovered = serveWorldView(f.ctx, { operation: "find_situations", label: "Deadline goal", ...ATTENTION_WHEN }).data;
    if (!("result" in discovered) || !("data" in discovered.result) || !("matches" in discovered.result.data)) throw new Error("goal missing");
    const goal = discovered.result.data.matches[0]!.ref;
    const read = () => {
      const body = serveWorldView(f.ctx, { operation: "situation", situation: goal, card: "kizuki.situation-card/v2", ...ATTENTION_WHEN }).data;
      if (!("result" in body) || !("data" in body.result)) throw new Error("deadline card unavailable");
      return body.result.data as SituationCardV2;
    };
    expect(read().commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === "conflicting")?.overdue).toBe("unknown");
    expect(read().commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === "self-report")?.status).toBe("claimed_done");
    const cues = candidates().filter(cue => cue.source === "commitment_due");
    expect(cues).toHaveLength(2);
    expect(new Set(cues.map(cue => cue.cue)).size).toBe(2);
    expect(cues.every(cue => cue.subject.token === goal.token)).toBe(true);
    // Disposition is never a gate on this existing canonical write/correction.
    setAttentionDisposition(f.ctx, cues[0]!.cue, "dismiss");
    const target = entries.find(entry => entry.name === "open")!;
    const claims = f.db.query<{ claim_id: string }, [string]>("SELECT claim_id FROM claim_v2_semantics WHERE subject_id=?").all(target.subject).map(row => getClaim(f.db, row.claim_id)!);
    applyCanonWrite({ db: f.db, vault_path: f.ctx.vaultPath }, claims, worldCanonTarget(f.db, claims[0]!.claim_id), { writer: "loop", budget: budget() });
    const open = read().commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === "open")!;
    await serveCorrect(f.ctx, { statement: "The owner confirms this commitment is done.", target: { world_claim: open.statusBasis[0]! }, mode: "replace_object", object: { kind: "vocabulary", id: "commitment/done" } });
    await complete();
    expect(read().commitments.find(c => c.commitment.token === open.commitment.token)?.status).toBe("done");
    expect(candidates().filter(cue => cue.source === "commitment_due")).toHaveLength(1);
    const expired = cues.find(cue => !candidates().some(current => current.cue === cue.cue))!;
    expect(await deliverAttention(f.ctx, expired.cue)).toEqual({ status: "unavailable" });
    expect(serveWorldView(f.ctx, { operation: "attention", ...ATTENTION_WHEN, valid: { kind: "at", at: "2029-01-01T00:00:00.000Z" } }).data).toMatchObject({ result: { status: "unavailable", reason: "history" } });
  } finally { f.dispose(); setSystemTime(); }
}, 120_000);

test("A2, A5, A6 domain graph, cross-domain links, task-bound slice, dependency weighting and correction support", async () => {
  setSystemTime(new Date("2030-01-10T12:00:00.000Z"));
  const f = await cardFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    // Seed domain concept, linked framework, open question, project situation, and unrelated personal history.
    await f.write("world.kind", vocabulary("world/concept"), { subject: "topic:posters" });
    await f.write("concept.label", literal("Poster design"), { subject: "topic:posters" });
    await f.write("concept.definition", literal("High-contrast visual hierarchy on a single sheet"), { subject: "topic:posters" });
    await f.write("concept.example", literal("Swiss International grid poster"), { subject: "topic:posters" });

    await f.write("world.kind", vocabulary("world/framework"), { subject: "framework:swiss-grid" });
    await f.write("framework.label", literal("Swiss Grid System"), { subject: "framework:swiss-grid" });
    await f.write("framework.applies_to", { kind: "subject", ref: f.ref("topic:posters") }, { subject: "framework:swiss-grid" });

    await f.write("world.kind", vocabulary("world/question"), { subject: "question:poster-margins" });
    await f.write("question.text", literal("What outer margin ratio balances large grotesk headlines?"), { subject: "question:poster-margins" });
    await f.write("question.status", vocabulary("question/open"), { subject: "question:poster-margins" });
    await f.write("gap.about", { kind: "subject", ref: f.ref("topic:posters") }, { subject: "question:poster-margins" });

    await f.write("world.kind", vocabulary("world/situation"), { subject: "situation:poster-campaign" });
    await f.write("situation.label", literal("Autumn exhibition poster campaign"), { subject: "situation:poster-campaign" });
    await f.write("situation.objective", literal("Ship three exhibition posters"), { subject: "situation:poster-campaign", context: ["topic:posters"] });

    await f.write("world.kind", vocabulary("world/concept"), { subject: "topic:personal-dental" });
    await f.write("concept.label", literal("Dental appointment history"), { subject: "topic:personal-dental" });
    await f.write("concept.definition", literal("Unrelated personal medical logistics"), { subject: "topic:personal-dental" });

    const discovered = serveWorldView(f.ctx, { operation: "find_concepts", label: "Poster design", ...ATTENTION_WHEN }).data;
    if (!("result" in discovered) || !("data" in discovered.result) || !("matches" in discovered.result.data)) throw new Error("domain missing");
    const posterRef = discovered.result.data.matches[0]!.ref;

    // Similarity-only cross-domain links are strictly rejected (A5).
    expect(buildCrossDomainLink({
      sourceRef: posterRef,
      targetRef: posterRef,
      targetKind: "situation",
      targetLabel: "Unverified similarity guess",
      predicate: "similar_to",
      basis: "similarity",
      evidence: [],
    })).toBeNull();

    const { graph, slice } = f.db.transaction(() => {
      const ns = worldNamespace(f.db, f.ctx.principal);
      const frame = { ctx: f.ctx, ns, registry: activeWorldOps() };
      const baseGraph = readDomainGraph(frame, posterRef, { kind: "all" }, { now: "2030-01-10T12:00:00.000Z" })!;
      const ev = baseGraph.concepts.items[0]!.evidence;
      const tasteRecords: TasteRecord[] = [
        {
          id: "t-poster-1", domain: "Poster design", context: ["poster-layout"],
          stance: "accepted", exampleLabel: "Asymmetric Swiss grid layout",
          reasons: ["Clear focal numeral and generous whitespace"],
          provenance: ev, observedAt: "2030-01-09T00:00:00.000Z", sourceKey: f.sourceKey, independence: "independent",
        },
        {
          id: "t-poster-2", domain: "Poster design", context: ["poster-layout"],
          stance: "rejected", exampleLabel: "Centered rainbow gradient banner",
          reasons: ["Generic decorative clutter obscures typography"],
          provenance: ev, observedAt: "2030-01-09T00:00:00.000Z", sourceKey: f.sourceKey, independence: "independent",
        },
        {
          id: "t-docs-1", domain: "Technical documentation", context: ["api-docs"],
          stance: "accepted", exampleLabel: "Dense schema reference table",
          reasons: ["Engineers need every parameter listed"],
          provenance: ev, observedAt: "2030-01-09T00:00:00.000Z", sourceKey: f.sourceKey, independence: "independent",
        },
      ];
      const fullGraph = readDomainGraph(frame, posterRef, { kind: "all" }, { now: "2030-01-10T12:00:00.000Z", tasteRecords })!;
      const taskSlice = compileTaskDomainSlice(frame, {
        domainRef: posterRef,
        task: "Design a poster layout for the exhibition",
        budgetTokens: 2000,
        valid: { kind: "all" },
        now: "2030-01-10T12:00:00.000Z",
        tasteRecords,
        tasteContext: ["poster-layout"],
      })!;
      return { graph: fullGraph, slice: taskSlice };
    }).immediate();

    // A2: Evidenced facets carry traceable evidence; missing experts stay unknown (never invented).
    expect(graph.concepts.status).toBe("evidenced");
    expect(graph.frameworks.status).toBe("evidenced");
    expect(graph.frameworks.items.map(item => item.label)).toEqual(["Swiss Grid System"]);
    expect(graph.openQuestions.status).toBe("evidenced");
    expect(graph.openQuestions.items[0]!.evidence.length).toBeGreaterThan(0);
    expect(graph.experts).toEqual({ status: "unknown", items: [], reason: "no_permitted_evidence" });

    // A5: Design-to-project link is claim-backed and reversible.
    const projectLink = graph.crossDomainLinks.find(link => link.targetKind === "situation");
    expect(projectLink).toBeDefined();
    expect(projectLink!.targetLabel).toBe("Autumn exhibition poster campaign");
    expect(projectLink!.reversible).toBe(true);
    expect(projectLink!.evidence.length).toBeGreaterThan(0);

    // A6: Task-bound slice delivers poster layout examples/reasons without unrelated history or other-domain taste.
    expect(slice.widenedScope).toBe(false);
    expect(slice.tokens).toBeLessThanOrEqual(slice.budgetTokens);
    expect(slice.tasteAccepted.map(item => item.exampleLabel)).toEqual(["Asymmetric Swiss grid layout"]);
    expect(slice.tasteRejected.map(item => item.exampleLabel)).toEqual(["Centered rainbow gradient banner"]);
    const sliceJson = JSON.stringify(slice);
    expect(sliceJson).not.toContain("Dental appointment history");
    expect(sliceJson).not.toContain("Dense schema reference table");

    // Correction support policy checks for classification, normal assertion, quoted attribution, and owner retraction.
    const kindRow = f.db.query<{ claim_id: string }, []>("SELECT claim_id FROM claim_v2_semantics WHERE subject_id='topic:posters' AND predicate='world.kind' LIMIT 1").get()!;
    const defRow = f.db.query<{ claim_id: string }, []>("SELECT claim_id FROM claim_v2_semantics WHERE subject_id='topic:posters' AND predicate='concept.definition' LIMIT 1").get()!;
    const kindMeaning = readClaimV2Semantic(f.db, kindRow.claim_id)!;
    const defMeaning = readClaimV2Semantic(f.db, defRow.claim_id)!;
    expect(describeCorrectionSupport(kindMeaning)).toMatchObject({
      supported: false,
      unsupportedReason: "classification_claim",
      allowedModes: ["merge_identity", "separate_identity"],
    });
    expect(canOwnerRetractClaim(kindMeaning)).toBe(false);
    expect(describeCorrectionSupport(defMeaning)).toMatchObject({
      supported: true,
      unsupportedReason: null,
      allowedModes: ["replace_object", "retract", "reclassify_mode"],
      requiresReceiptedUndo: true,
    });
    expect(canOwnerRetractClaim(defMeaning)).toBe(true);
    expect(isOwnerInterestRetraction({
      predicate: "person.interest",
      polarity: "negative",
      assessments: [{
        admission: { kind: "admission", token: "a".repeat(43) },
        epistemicKind: "owner_assertion",
        authority: "owner_correction",
        confidence: { kind: "known", value: 1 },
        independence: "independent",
        evidence: [],
      }],
    })).toBe(true);

    // Dependency weighting: deduplicates across children, decays deterministically, and zero-weights copies and summary replays.
    const parentDeps = worldDependencies();
    const childDeps = worldDependencies();
    recordDependencyWeight(parentDeps, { key: "event:1", kind: "event", weightClass: "independent_evidence", observedAt: "2030-01-10T12:00:00.000Z" });
    recordDependencyWeight(childDeps, { key: "event:1", kind: "event", weightClass: "owner_assertion", observedAt: "2030-01-10T12:00:00.000Z" });
    recordDependencyWeight(childDeps, { key: "event:copy", kind: "event", weightClass: "dependent_copy", weight: 0.9, observedAt: "2030-01-10T12:00:00.000Z" });
    recordDependencyWeight(childDeps, { key: "summary:1", kind: "consolidation", weightClass: "generated_summary", weight: 0.9, observedAt: "2030-01-10T12:00:00.000Z" });
    mergeWorldDependencies(parentDeps, childDeps);
    const wFresh = effectiveDependencyWeight(parentDeps, { now: "2030-01-10T12:00:00.000Z", halfLifeDays: 30 });
    const wHalf = effectiveDependencyWeight(parentDeps, { now: "2030-02-09T12:00:00.000Z", halfLifeDays: 30 });
    expect(wFresh).toEqual({
      totalWeight: 1,
      independentWeight: 1,
      independentCount: 1,
      dependentCopyCount: 1,
      summaryReplayCount: 1,
      entryCount: 3,
    });
    expect(wHalf.independentWeight).toBeCloseTo(0.5, 4);
  } finally { f.dispose(); setSystemTime(); }
}, 120_000);
