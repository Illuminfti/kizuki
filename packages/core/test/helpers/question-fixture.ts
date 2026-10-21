import type { Database } from "bun:sqlite";
import type { QuestionCard } from "../../src/contracts/question-card";
import { serveWorldView } from "../../src/serving/world-view";
import { cardFixture } from "../world/card-fixture";

export const QUESTION = "question:updating";
export const QUESTION_WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const WHEN = QUESTION_WHEN;

export async function questionFixture(database?: Database, options: Parameters<typeof cardFixture>[1] = {}) {
  const f = await cardFixture(database, options);
  try {
    const write = (predicate: string, object: Parameters<typeof f.write>[1], options: Parameters<typeof f.write>[2] = {}) =>
      f.write(predicate, object, { subject: QUESTION, ...options });
    await write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/question" } });
    await write("question.text", { kind: "literal", value: "When should I update a belief?" });
    await write("question.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/open" } });
    await write("gap.about", { kind: "subject", ref: f.ref("topic:bayes") });
    const found = serveWorldView(f.ctx, { operation: "find_questions", label: "update", about: f.find(), ...WHEN }).data;
    if (!("result" in found) || !("data" in found.result) || !("matches" in found.result.data)) throw new Error("question not discovered");
    const ref = found.result.data.matches[0]!.ref;
    const read = (): QuestionCard => {
      const result = serveWorldView(f.ctx, { operation: "question", question: ref, ...WHEN }).data;
      if (!("result" in result) || !("data" in result.result)) throw new Error("question not readable");
      return result.result.data as QuestionCard;
    };
    return { ...f, writeQuestion: write, questionRef: ref, readQuestion: read };
  } catch (error) { f.dispose(); throw error; }
}
