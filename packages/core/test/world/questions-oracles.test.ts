import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { withWorldPipeline } from "@kizuki/core/testing";
import { serveCorrect } from "../../src/serving/correct";
import { supportLineage } from "../../src/world/lineage";
import { questionFixture } from "../helpers/question-fixture";

const design = (name: string) => JSON.parse(readFileSync(new URL(`../../../../rfcs/fixtures/${name}.json`, import.meta.url), "utf8"));

test("world-question-copy-design runs copied answers and later partial evidence through the admitted Question reader", async () => {
  const spec = design("world-question-copy-design"), f = await questionFixture();
  try {
    for (const candidate of spec.candidates) {
      const copied = candidate.kind === "copied_model_answer";
      for (let i = 0; i < (copied ? spec.curiosity.mention_count : 1); i++)
        await f.writeQuestion("question.candidate_answer", { kind: "literal", value: candidate.id }, {
          text: `Answer evidence ${candidate.evidence_ref}.`, metadata: copied ? { generated_from: "synthetic-model-answer" } : {},
        });
    }
    let roots = -1;
    const card = withWorldPipeline({ enrichers: [(frame, body) => {
      roots = supportLineage(frame, body.claims.filter(claim => claim.relation.predicate === "question.candidate_answer").flatMap(claim => claim.eligible.supports)).count;
      return body;
    }] }, () => f.readQuestion());
    expect(card.lifecycle.status).toBe(spec.oracle.lifecycle);
    expect(roots).toBe(spec.oracle.independent_corroboration_count);
    const copied = card.answers.find(item => item.object.kind === "literal" && item.object.value === "c_copied_model")!;
    expect(copied.assessments.some(item => item.independence === "independent")).toBe(spec.oracle.copied_answer_is_independent_witness);
    expect(card.lifecycle.status === "resolved").toBe(spec.oracle.resolved);
    expect(card.understanding).toBe(spec.understanding.owner_understanding);
    expect(Object.hasOwn(card, "curiosity") || Object.hasOwn(card, "importance")).toBe(spec.oracle.curiosity_from_frequency);
  } finally { f.dispose(); }
}, 120_000);

test("world-question-reopen-design runs owner resolution and a later contradiction without retaining resolved status", async () => {
  const spec = design("world-question-reopen-design"), f = await questionFixture();
  try {
    const answer = { kind: "literal", value: spec.resolution.resolved_by_ref } as const;
    await f.writeQuestion("question.candidate_answer", answer);
    await serveCorrect(f.ctx, { statement: "I mark this question resolved.", target: { world_claim: f.readQuestion().statusEvidence[0]!.claim },
      mode: "replace_object", object: { kind: "vocabulary", id: `question/${spec.question.prior_lifecycle}` } });
    expect(f.readQuestion().lifecycle.status).toBe(spec.question.prior_lifecycle);
    await f.writeQuestion("question.candidate_answer", answer, { polarity: "negative", text: spec.resolution.contradicted_by_ref });
    const status = f.readQuestion().lifecycle.status;
    expect(status).toBe(spec.oracle.lifecycle);
    expect(status === "resolved").toBe(spec.oracle.resolved);
    expect(status === "abandoned").toBe(spec.oracle.abandoned);
    expect(status === spec.question.prior_lifecycle).toBe(spec.oracle.prior_resolution_survives_contradiction);
    await serveCorrect(f.ctx, { statement: "I abandon this question.", target: { world_claim: f.readQuestion().statusEvidence[0]!.claim },
      mode: "replace_object", object: { kind: "vocabulary", id: "question/abandoned" } });
    expect(f.readQuestion().lifecycle.status).toBe("abandoned");
    expect(f.readQuestion().lifecycle.status === "resolved").toBe(spec.abandonment.abandoned_is_resolved);
  } finally { f.dispose(); }
}, 120_000);
