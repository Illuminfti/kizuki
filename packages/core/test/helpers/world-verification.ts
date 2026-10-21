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
  "evidence", "history", "share", "resume", "question", "find_questions", "frontier",
] as const;
export type VerificationOperation = typeof WORLD_VERIFICATION_OPERATIONS[number];
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const input = (operation: string, own = {}) => ({ operation, ...own, ...WHEN });

export async function verificationScene(): Promise<NoninterferenceScene> {
  const base = await hiddenScene();
  try {
    await worldSeed(base.db, { kind: "question", subject: QUESTION, label: "When should I update a belief?", discover: false,
      predicates: [{ predicate: "question.status", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/open" } } }] });
    const agent = addAgent(base.db, "verification-reader", {
      ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["topic:bayes", "project:launch", QUESTION],
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
      dispose() { base.dispose(); },
    };
  } catch (error) { base.dispose(); throw error; }
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
  const of = { operation: "concept", concept: scene.refs.concept };
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
    history: input("history", { concept: scene.refs.concept }), share: input("share", { of }),
    resume: input("resume", { handle }), question: input("question", { question }),
    find_questions: input("find_questions", { label: "update" }), frontier: input("frontier"),
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
  return WORLD_VERIFICATION_OPERATIONS.map(name => {
    let work = { frames: 0, rowsExamined: 0, claimsVerified: 0, parsedBytes: 0 };
    return { name, run(ctx) {
      const observed = collectReadFrames(() => serveWorldView(ctx, inputs[name]));
      work = { frames: observed.frames.length,
        rowsExamined: observed.frames.reduce((n, frame) => n + frame.stats.rowsExamined, 0),
        claimsVerified: observed.frames.reduce((n, frame) => n + frame.stats.claimsVerified, 0),
        parsedBytes: observed.frames.reduce((n, frame) => n + frame.budget.bytes, 0) };
      return name === "share" ? normalizeShare(observed.result) : observed.result;
    }, stats: () => work };
  });
}
