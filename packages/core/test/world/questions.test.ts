import { expect, test } from "bun:test";
import { withWorldPipeline } from "@kizuki/core/testing";
import { supportLineage } from "../../src/world/lineage";
import { serveCorrect } from "../../src/serving/correct";
import { serveWorldView } from "../../src/serving/world-view";
import { questionFixture as fixture, QUESTION_WHEN as WHEN } from "../helpers/question-fixture";

test("Questions are discoverable by about, keep copied answers unresolved, and expose an attributable frontier", async () => {
  const f = await fixture();
  try {
    const answer = { kind: "literal", value: "Update when independent evidence changes the likelihood." } as const;
    await f.writeQuestion("question.candidate_answer", answer, { text: "Copied AI answer: update when independent evidence changes the likelihood." });
    await f.writeQuestion("question.candidate_answer", answer, { text: "Copied AI answer: update when independent evidence changes the likelihood." });
    let roots = -1;
    const card = withWorldPipeline({ enrichers: [(frame, body) => {
      roots = supportLineage(frame, body.claims.filter(claim => claim.relation.predicate === "question.candidate_answer").flatMap(claim => claim.eligible.supports)).count;
      return body;
    }] }, () => f.readQuestion());
    expect(card.schema).toBe("kizuki.question-card/v1");
    expect(card.lifecycle.status).toBe("open");
    expect(card.answers).toHaveLength(1);
    expect(card.answers[0]!.assessments).toHaveLength(2);
    expect(card.answers[0]!.assessments.every(item => item.independence === "dependent")).toBe(true);
    expect(roots).toBe(1);
    expect(card.understanding).toBe("unknown");
    const frontier = serveWorldView(f.ctx, { operation: "frontier", about: f.find(), ...WHEN }).data;
    expect(frontier).toMatchObject({ result: { status: "incomplete", data: {
      schema: "kizuki.frontier/v1", groups: [{ kind: "unresolved_question", questions: [f.questionRef] }],
      coverage: { status: "partial" },
    } } });
  } finally { f.dispose(); }
}, 120_000);

test("owner resolution does not imply understanding; a contradictory answer reopens it and abandonment stays abandoned", async () => {
  const f = await fixture();
  try {
    const answer = { kind: "literal", value: "Update when independent evidence changes the likelihood." } as const;
    await f.writeQuestion("question.candidate_answer", answer);
    const mark = async (status: "resolved" | "abandoned") => {
      const relation = f.readQuestion().statusEvidence[0]!;
      await serveCorrect(f.ctx, {
        statement: `I mark this question ${status}.`, target: { world_claim: relation.claim },
        mode: "replace_object", object: { kind: "vocabulary", id: `question/${status}` },
      });
    };
    await mark("resolved");
    expect(f.readQuestion()).toMatchObject({ lifecycle: { status: "resolved" }, understanding: "unknown" });
    await f.writeQuestion("question.candidate_answer", answer, { polarity: "negative", text: "This proposed answer is contradicted by the new evidence." });
    expect(f.readQuestion().lifecycle.status).toBe("reopened");
    await mark("abandoned");
    expect(f.readQuestion().lifecycle.status).toBe("abandoned");
  } finally { f.dispose(); }
}, 120_000);
