import { forecastVerificationFixture, FORECAST_SUBJECTS } from "./forecast-verification";
import { EMPTY_SUMMARY_MODEL, completeEmptyWorldSummaries } from "./world-consolidation";
import { artifactFixture } from "./artifact-fixture";
import { skillFixture, PROCEDURE, SKILL, FRAMEWORK } from "./skill-fixture";
/** Explicit public-operation scenarios. A new operation must supply a real case. */
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { serveWorldView } from "../../src/serving/world-view";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { QUESTION } from "./question-fixture";
import { worldSeed } from "./world-seed";
import { hiddenScene, type NoninterferenceScene, type ReadCase } from "./noninterference";
import type { ConceptCard } from "../../src/contracts/concept-card";
import type { ShareData } from "../../src/world/views/resume";

export const WORLD_VERIFICATION_OPERATIONS = [
  "find_concepts", "find_situations", "concept", "situation", "describe",
  "evidence", "observation", "history", "share", "resume", "question", "find_questions", "frontier", "person", "find_people", "find_procedures", "procedure", "skill", "framework", "outcome", "artifact_version", "find_artifacts", "diff", "slice", "atlas", "attention", "forecast", "forecast_scores",
] as const;
export type VerificationOperation = typeof WORLD_VERIFICATION_OPERATIONS[number];
const PERSON = "person:verification-ada";
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const input = (operation: string, own = {}) => ({ operation, ...own, ...WHEN });

export async function verificationScene(): Promise<NoninterferenceScene> {
  const base = await hiddenScene({model:EMPTY_SUMMARY_MODEL});
  let forecasts: Awaited<ReturnType<typeof forecastVerificationFixture>> | undefined;
  let skills: Awaited<ReturnType<typeof skillFixture>> | undefined;
  let artifacts: Awaited<ReturnType<typeof artifactFixture>> | undefined;
  try {
    forecasts = await forecastVerificationFixture(base.db);
    skills = await skillFixture(base.db);
    artifacts = await artifactFixture(base.db);
    const artifact = await artifacts.capture("Synthetic verification artifact exact bytes.");
    await skills.file(0, "outcome.self_report");
    await worldSeed(base.db, { kind: "question", subject: QUESTION, label: "When should I update a belief?", discover: false,
      predicates: [{ predicate: "question.status", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/open" } } }] });
    await worldSeed(base.db, { kind: "person", subject: PERSON, label: "Ada", discover: false,
      predicates: [{ predicate: "person.role", object: { kind: "literal", value: "Reviewer" } }] });
    await completeEmptyWorldSummaries(base.db, base.vaultPath);
    const agent = addAgent(base.db, "verification-reader", {
      ...OWNER_AGENT_GRANT, ceiling: "public", subjects: [...FORECAST_SUBJECTS, "topic:bayes", "project:launch", QUESTION, PERSON, PROCEDURE, SKILL, FRAMEWORK, "framework:inspection", artifact.subject.id, ...(artifact.metadata.versionOf ? [artifact.metadata.versionOf] : [])],
      // Four observations per operation plus setup reads; production limits stay unchanged.
      rate_limit_per_minute: 4 * WORLD_VERIFICATION_OPERATIONS.length + 16,
    });
    const reader = { ...base.reader, principal: authenticate(base.db, agent.token)! };
    const ref = (operation: string, label: string) => {
      const data = serveWorldView(reader, input(operation, { label })).data;
      if (!("result" in data) || !("data" in data.result) || !("matches" in data.result.data)) throw new Error("verification discovery failed");
      const found = data.result.data.matches[0]?.ref;
      if (!found) throw new Error("verification positive control is absent");
      return found;
    };
    return { ...base, reader,
      refs: { concept: ref("find_concepts", "Bayesian"), situation: ref("find_situations", "Launch") },
      dispose() { forecasts?.dispose(); artifacts?.dispose(); skills?.dispose(); base.dispose(); },
    };
  } catch (error) { forecasts?.dispose(); artifacts?.dispose(); skills?.dispose(); base.dispose(); throw error; }
}

export function verificationInputs(scene: NoninterferenceScene): Record<VerificationOperation, Record<string, unknown>> {
  const read = (operation: string, own: Record<string, unknown>) => serveWorldView(scene.reader, input(operation, own)).data;
  const concept = read("concept", { concept: scene.refs.concept });
  if (!("result" in concept) || !("data" in concept.result)) throw new Error("verification concept failed");
  const evidence = (concept.result.data as ConceptCard).definitions[0]?.assessments[0]?.evidence[0];
  if (!evidence) throw new Error("verification evidence failed");
  const questions = read("find_questions", { label: "update" });
  if (!("result" in questions) || !("data" in questions.result) || !("matches" in questions.result.data)) throw new Error("verification questions failed");
  const question = questions.result.data.matches[0]?.ref;
  if (!question) throw new Error("verification Question positive control is absent");
  const people = read("find_people", { label: "Ada" });
  if (!("result" in people) || !("data" in people.result) || !("matches" in people.result.data)) throw new Error("verification people failed");
  const person = people.result.data.matches[0]?.ref;
  if (!person) throw new Error("verification Person positive control is absent");
  const procedures = read("find_procedures", { label: "verify" });
  if (!("result" in procedures) || !("data" in procedures.result) || !("matches" in procedures.result.data)) throw new Error("verification procedures failed");
  const procedure = procedures.result.data.matches[0]?.ref;
  if (!procedure) throw new Error("verification Procedure positive control is absent");
  const procedural = read("procedure", { procedure });
  if (!("result" in procedural) || !("data" in procedural.result) || procedural.result.data.schema !== "kizuki.procedure-card/v1") throw new Error("verification procedure failed");
  const skillNode = procedural.result.data.applicability.requiredCapabilities[0]?.object;
  const frameworkNode = procedural.result.data.applicability.prerequisites[0]?.object;
  if (skillNode?.kind !== "node" || frameworkNode?.kind !== "node") throw new Error("verification skill/framework positive controls are absent");
  const artifacts = read("find_artifacts", { label: "Artifact" });
  if (!("result" in artifacts) || !("data" in artifacts.result) || !("matches" in artifacts.result.data)) throw new Error("verification artifacts failed");
  const artifact = artifacts.result.data.matches[0]?.ref;
  if (!artifact) throw new Error("verification ArtifactVersion positive control is absent");
  const forecastBoards = read("find_situations", { label: "Forecast verification board" });
  if (!("result" in forecastBoards) || !("data" in forecastBoards.result) || !("matches" in forecastBoards.result.data)) throw Error("forecast board missing");
  const forecastBoard = read("situation", { situation: forecastBoards.result.data.matches[0]!.ref, card: "kizuki.situation-card/v2" });
  if (!("result" in forecastBoard) || !("data" in forecastBoard.result) || forecastBoard.result.data.schema !== "kizuki.situation-card/v2") throw Error("forecast card missing");
  const commitment = forecastBoard.result.data.commitments[0]?.commitment;
  if (!commitment) throw Error("forecast positive control missing");
  const of = { operation: "concept", concept: scene.refs.concept };
  if (concept.result.status !== "current" || !("kind" in concept.result.view)) throw new Error("verification diff baseline is incomplete");
  const shared = read("share", { of });
  if (!("result" in shared) || !("data" in shared.result)) throw new Error("verification sharing failed");
  const handle = (shared.result.data as ShareData).handle;
  if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) throw new Error("verification resume handle failed");
  return {
    find_concepts: input("find_concepts", { label: "Bayesian" }),
    find_situations: input("find_situations", { label: "Launch" }),
    concept: input("concept", { concept: scene.refs.concept }),
    situation: input("situation", { situation: scene.refs.situation }),
    describe: input("describe"), evidence: input("evidence", { evidence }),
    observation: input("observation", { ref: evidence.admission }),
    history: input("history", { concept: scene.refs.concept }), share: input("share", { of }),
    resume: input("resume", { handle }), question: input("question", { question }),
    find_questions: input("find_questions", { label: "update" }), frontier: input("frontier"),
    attention: input("attention"),
    forecast: input("forecast", { commitment }), forecast_scores: input("forecast_scores"),
    atlas: input("atlas", { panel: "people" }),
    slice: input("slice", { task: "Resume the launch", kinds: ["concept", "situation"], budgetTokens: 2000 }),
    person: input("person", { person }), find_people: input("find_people", { label: "Ada" }),
    find_procedures: input("find_procedures", { label: "verify" }), procedure: input("procedure", { procedure }),
    skill: input("skill", { skill: skillNode.ref }), framework: input("framework", { framework: frameworkNode.ref }),
    outcome: input("outcome", { subject: PROCEDURE }),
    artifact_version: input("artifact_version", { artifact }), find_artifacts: input("find_artifacts", { label: "Artifact" }),
    diff: input("diff", { of, priorView: concept.result.view }),
  };
}

/** Only freshly generated share capabilities vary. Assert their grammar before normalizing. */
function normalizeShare(value: ReturnType<typeof serveWorldView>): unknown {
  const data = value.data;
  if (!("result" in data) || !("data" in data.result) || data.result.data.schema !== "kizuki.resume-handle/v1") return value;
  const share = data.result.data as ShareData;
  if (!/^[A-Za-z0-9_-]{43}$/.test(share.handle)) throw new Error("invalid issued share capability");
  return { ...value, data: { ...data, result: { ...data.result, data: { ...share, handle: "<fresh share capability>" } } } };
}

export function verificationCases(scene: NoninterferenceScene): readonly ReadCase[] {
  const inputs = verificationInputs(scene);
  // Other operations deliberately issue many views. Give this long-lived
  // conditional baseline its own identical grant and fixed cache partition,
  // so ordinary 16-slot eviction cannot turn the privacy check into a stale-token check.
  const agent = addAgent(scene.db, "verification-diff-reader", scene.reader.principal.grant);
  const diffPrincipal = authenticate(scene.db, agent.token)!;
  const reader = { ...scene.reader, principal: diffPrincipal };
  const found = serveWorldView(reader, input("find_concepts", { label: "Bayesian" })).data;
  if (!("result" in found) || !("data" in found.result) || !("matches" in found.result.data)) throw Error("diff verification discovery required");
  const of = { operation: "concept", concept: found.result.data.matches[0]!.ref };
  const baseline = serveWorldView(reader, { ...of, ...WHEN }).data;
  if (!("result" in baseline) || baseline.result.status !== "current" || !("kind" in baseline.result.view)) throw Error("diff verification baseline required");
  inputs.diff = input("diff", { of, priorView: baseline.result.view });
  return WORLD_VERIFICATION_OPERATIONS.map(name => {
    let work = { frames: 0, rowsExamined: 0, claimsVerified: 0, parsedBytes: 0 };
    return { name, run(ctx) {
      const observed = collectReadFrames(() => serveWorldView(name === "diff" ? { ...ctx, principal: diffPrincipal } : ctx, inputs[name]));
      if (name === "diff" && (!("result" in observed.result.data) || observed.result.data.result.status !== "unchanged"))
        throw Error("diff noninterference lost its live baseline");
      work = { frames: observed.frames.length,
        rowsExamined: observed.frames.reduce((n, frame) => n + frame.stats.rowsExamined, 0),
        claimsVerified: observed.frames.reduce((n, frame) => n + frame.stats.claimsVerified, 0),
        parsedBytes: observed.frames.reduce((n, frame) => n + frame.budget.bytes, 0) };
      return name === "share" ? normalizeShare(observed.result) : observed.result;
    }, stats: () => work };
  });
}
