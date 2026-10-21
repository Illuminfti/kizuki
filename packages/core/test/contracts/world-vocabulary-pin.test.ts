import { expect, test } from "bun:test";
import { WORLD_VOCABULARY, WORLD_VOCABULARY_SCHEMA } from "../../src/contracts/world-vocabulary";

/**
 * Every shipped row of kizuki.world-vocabulary/v1, spelled out. New kinds extend
 * the world.kind classification set additively. A change to an
 * existing row changes what a stored claim means, so it needs a new schema id
 * and a migration story, not an edit of this table.
 */
const PINNED_ROWS = [
  ["world.kind", "raw", "vocabulary", "positive,negative", null, "world/concept,world/framework,world/person,world/procedure,world/question,world/situation,world/skill"],
  ["situation.label", "situation", "literal", "positive,negative", 400, null],
  ["situation.objective", "situation", "literal", "positive,negative", 400, null],
  ["situation.commitment", "situation", "literal", "positive,negative", 400, null],
  ["situation.blocker", "situation", "literal", "positive,negative", 400, null],
  ["situation.change", "situation", "literal", "positive,negative", 400, null],
  ["situation.participant", "situation", "raw_subject", "positive,negative", null, null],
  ["concept.label", "concept", "literal", "positive,negative", 400, null],
  ["concept.definition", "concept", "literal", "positive,negative", 400, null],
  ["concept.requires", "concept", "concept", "positive,negative", null, null],
  ["concept.example", "concept", "literal,raw_subject", "positive,negative", 400, null],
  ["concept.counterexample", "concept", "literal,raw_subject", "positive,negative", 400, null],
  ["concept.same_as", "concept", "concept", "positive,negative", null, null],
  ["concept.distinguished_from", "concept", "concept", "positive,negative", null, null],
  ["learning.exposure", "person", "concept", "positive,negative", null, null],
  ["learning.explanation", "person", "concept", "positive,negative", null, null],
  ["learning.application", "person", "concept", "positive,negative", null, null],
  ["learning.demonstration", "person", "concept", "positive,negative", null, null],
  ["learning.assistance", "task_context", "vocabulary", "positive,negative", null, "learning/assisted,learning/unassisted"],
  ["question.text", "question", "literal", "positive,negative", 400, null],
  ["question.status", "question", "vocabulary", "positive,negative", null, "question/open,question/partial,question/resolved,question/reopened,question/abandoned"],
  ["question.candidate_answer", "question", "literal,raw_subject", "positive,negative", 400, null],
  ["question.motivates", "question", "raw_subject", "positive,negative", null, null],
  ["gap.kind", "question", "vocabulary", "positive,negative", null, "gap/missing_prerequisite,gap/unresolved_question,gap/contradiction,gap/stale_evidence,gap/misconception,gap/lack_of_practice,gap/missing_information"],
  ["gap.about", "question", "raw_subject", "positive,negative", null, null],
  ["person.label", "person", "literal", "positive,negative", 400, null],
  ["person.role", "person", "literal", "positive,negative", 400, null],
  ["relationship.with", "person", "raw_subject", "positive,negative", null, null],
  ["skill.label", "skill", "literal", "positive,negative", 400, null],
  ["skill.evidence", "skill", "vocabulary", "positive,negative", null, "skill/self_report,skill/exposure,skill/explanation,skill/application,skill/observed_outcome"],
  ["skill.about", "skill", "raw_subject", "positive,negative", null, null],
  ["skill.demonstration", "skill", "raw_subject", "positive,negative", null, null],
  ["skill.outcome", "skill", "raw_subject", "positive,negative", null, null],
  ["skill.last_validated", "skill", "literal", "positive,negative", 400, null],
  ["framework.label", "framework", "literal", "positive,negative", 400, null],
  ["framework.purpose", "framework", "literal", "positive,negative", 400, null],
  ["framework.includes", "framework", "raw_subject", "positive,negative", null, null],
  ["framework.component", "framework", "raw_subject", "positive,negative", null, null],
  ["framework.assumption", "framework", "literal", "positive,negative", 400, null],
  ["framework.applies_to", "framework", "raw_subject,literal", "positive,negative", 400, null],
  ["framework.failure_mode", "framework", "literal", "positive,negative", 400, null],
  ["framework.lifecycle", "framework", "vocabulary", "positive,negative", null, "framework/encountered,framework/understood,framework/testing,framework/adopted,framework/modified,framework/rejected,framework/superseded"],
  ["procedure.label", "procedure", "literal", "positive,negative", 400, null],
  ["procedure.step", "procedure", "literal", "positive,negative", 400, null],
  ["procedure.strategy", "procedure", "literal", "positive,negative", 400, null],
  ["procedure.prerequisite", "procedure", "raw_subject,literal", "positive,negative", 400, null],
  ["procedure.applies_to", "procedure", "raw_subject,literal", "positive,negative", 400, null],
  ["procedure.required_capability", "procedure", "raw_subject", "positive,negative", null, null],
  ["procedure.success_check", "procedure", "literal", "positive,negative", 400, null],
  ["procedure.failure_mode", "procedure", "literal", "positive,negative", 400, null],
  ["procedure.counterexample", "procedure", "literal,raw_subject", "positive,negative", 400, null],
  ["procedure.last_validated", "procedure", "literal", "positive,negative", 400, null],
  ["procedure.outcome", "procedure", "raw_subject", "positive,negative", null, null],
  ["procedure.standard", "procedure", "literal", "positive,negative", 400, null],
  ["procedure.exemplar", "procedure", "raw_subject", "positive,negative", null, null],
] as const;

test("the shipped rows of kizuki.world-vocabulary/v1 keep their meaning", () => {
  expect(WORLD_VOCABULARY_SCHEMA).toBe("kizuki.world-vocabulary/v1");
  expect(
    WORLD_VOCABULARY.map(spec => [spec.predicate, spec.subject, spec.objects.join(","), spec.polarity.join(","), spec.max_literal_chars,
      spec.vocabulary_values === null ? null : spec.vocabulary_values.join(",")]),
  ).toEqual(PINNED_ROWS.map(row => [...row]));
  expect(WORLD_VOCABULARY.every(spec => spec.cardinality === "multi")).toBe(true);
});
