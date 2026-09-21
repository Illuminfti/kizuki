import { describe, expect, test } from "bun:test";
import {
  WORLD_VOCABULARY,
  WORLD_VOCABULARY_PREDICATES,
  WORLD_VOCABULARY_SCHEMA,
  getWorldVocabularySpec,
  isWorldVocabularyPredicate,
} from "../../src/contracts/world-vocabulary";

describe("world vocabulary v1", () => {
  test("locks the accepted RFC 0004 predicate set", () => {
    expect(WORLD_VOCABULARY_SCHEMA).toBe("kizuki.world-vocabulary/v1");
    expect(WORLD_VOCABULARY.map((entry) => entry.predicate)).toEqual([
      ...WORLD_VOCABULARY_PREDICATES,
    ]);
    expect(new Set(WORLD_VOCABULARY_PREDICATES).size).toBe(18);
  });

  test("locks endpoint shapes and trusted vocabulary values", () => {
    expect(getWorldVocabularySpec("world.kind")).toMatchObject({
      subject: "raw",
      objects: ["vocabulary"],
      vocabulary_values: ["world/concept","world/situation"],
    });
    expect(getWorldVocabularySpec("concept.example")).toMatchObject({
      subject: "concept",
      objects: ["literal", "raw_subject"],
      max_literal_chars: 400,
    });
    expect(getWorldVocabularySpec("learning.assistance")).toMatchObject({
      subject: "task_context",
      objects: ["vocabulary"],
      vocabulary_values: ["learning/assisted", "learning/unassisted"],
    });
  });

  test("keeps every accepted predicate multi-valued and polarity-preserving", () => {
    for (const spec of WORLD_VOCABULARY) {
      expect(spec.cardinality).toBe("multi");
      expect(spec.polarity).toEqual(["positive", "negative"]);
    }
  });

  test("does not treat unknown predicates as vocabulary", () => {
    expect(isWorldVocabularyPredicate("concept.label")).toBe(true);
    expect(isWorldVocabularyPredicate("project.status")).toBe(false);
    expect(getWorldVocabularySpec("world.future")).toBeUndefined();
  });
});
