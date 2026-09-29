import { expect, test } from "bun:test";
import { WORLD_VOCABULARY, WORLD_VOCABULARY_SCHEMA } from "../../src/contracts/world-vocabulary";

/**
 * Every shipped row of kizuki.world-vocabulary/v1, spelled out. A change to an
 * existing row changes what a stored claim means, so it needs a new schema id
 * and a migration story, not an edit of this table.
 */
const PINNED_ROWS = [
  ["world.kind", "raw", "vocabulary", "positive,negative", null, "world/concept,world/situation"],
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
  ["concept.distinguished_from", "concept", "concept", "positive,negative", null, null],
  ["learning.exposure", "person", "concept", "positive,negative", null, null],
  ["learning.explanation", "person", "concept", "positive,negative", null, null],
  ["learning.application", "person", "concept", "positive,negative", null, null],
  ["learning.demonstration", "person", "concept", "positive,negative", null, null],
  ["learning.assistance", "task_context", "vocabulary", "positive,negative", null, "learning/assisted,learning/unassisted"],
] as const;

test("the shipped rows of kizuki.world-vocabulary/v1 keep their meaning", () => {
  expect(WORLD_VOCABULARY_SCHEMA).toBe("kizuki.world-vocabulary/v1");
  expect(
    WORLD_VOCABULARY.map(spec => [spec.predicate, spec.subject, spec.objects.join(","), spec.polarity.join(","), spec.max_literal_chars,
      spec.vocabulary_values === null ? null : spec.vocabulary_values.join(",")]),
  ).toEqual(PINNED_ROWS.map(row => [...row]));
  expect(WORLD_VOCABULARY.every(spec => spec.cardinality === "multi")).toBe(true);
});
