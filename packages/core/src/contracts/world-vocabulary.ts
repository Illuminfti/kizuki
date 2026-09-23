export const WORLD_VOCABULARY_SCHEMA = "kizuki.world-vocabulary/v1" as const;

export const WORLD_VOCABULARY_PREDICATES = [
  "world.kind",
  "situation.label", "situation.objective", "situation.commitment", "situation.blocker", "situation.change", "situation.participant",
  "concept.label",
  "concept.definition",
  "concept.requires",
  "concept.example",
  "concept.counterexample",
  "concept.distinguished_from",
  "learning.exposure",
  "learning.explanation",
  "learning.application",
  "learning.demonstration",
  "learning.assistance",
] as const;

export type WorldVocabularyPredicate =
  (typeof WORLD_VOCABULARY_PREDICATES)[number];

export type WorldEndpointKind =
  | "raw"
  | "concept"
  | "situation"
  | "person"
  | "task_context";

export type WorldObjectKind =
  | "literal"
  | "concept"
  | "raw_subject"
  | "vocabulary";

export interface WorldVocabularySpec {
  readonly predicate: WorldVocabularyPredicate;
  readonly subject: WorldEndpointKind;
  readonly objects: readonly WorldObjectKind[];
  readonly cardinality: "multi";
  readonly polarity: readonly ("positive" | "negative")[];
  readonly max_literal_chars: number | null;
  readonly vocabulary_values: readonly string[] | null;
}

const BOTH_POLARITIES = Object.freeze(["positive", "negative"] as const);
const LITERAL_MAX_CHARS = 400;

export const WORLD_VOCABULARY: readonly WorldVocabularySpec[] = Object.freeze([
  {
    predicate: "world.kind",
    subject: "raw",
    objects: Object.freeze(["vocabulary"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: null,
    vocabulary_values: Object.freeze(["world/concept", "world/situation"] as const),
  },
  ...(["situation.label", "situation.objective", "situation.commitment", "situation.blocker", "situation.change"] as const).map(predicate => ({
    predicate, subject: "situation" as const, objects: Object.freeze(["literal"] as const), cardinality: "multi" as const,
    polarity: BOTH_POLARITIES, max_literal_chars: LITERAL_MAX_CHARS, vocabulary_values: null,
  })),
  { predicate: "situation.participant", subject: "situation", objects: Object.freeze(["raw_subject"] as const), cardinality: "multi",
    polarity: BOTH_POLARITIES, max_literal_chars: null, vocabulary_values: null },
  {
    predicate: "concept.label",
    subject: "concept",
    objects: Object.freeze(["literal"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: LITERAL_MAX_CHARS,
    vocabulary_values: null,
  },
  {
    predicate: "concept.definition",
    subject: "concept",
    objects: Object.freeze(["literal"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: LITERAL_MAX_CHARS,
    vocabulary_values: null,
  },
  {
    predicate: "concept.requires",
    subject: "concept",
    objects: Object.freeze(["concept"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: null,
    vocabulary_values: null,
  },
  {
    predicate: "concept.example",
    subject: "concept",
    objects: Object.freeze(["literal", "raw_subject"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: LITERAL_MAX_CHARS,
    vocabulary_values: null,
  },
  {
    predicate: "concept.counterexample",
    subject: "concept",
    objects: Object.freeze(["literal", "raw_subject"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: LITERAL_MAX_CHARS,
    vocabulary_values: null,
  },
  {
    predicate: "concept.distinguished_from",
    subject: "concept",
    objects: Object.freeze(["concept"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: null,
    vocabulary_values: null,
  },
  {
    predicate: "learning.exposure",
    subject: "person",
    objects: Object.freeze(["concept"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: null,
    vocabulary_values: null,
  },
  {
    predicate: "learning.explanation",
    subject: "person",
    objects: Object.freeze(["concept"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: null,
    vocabulary_values: null,
  },
  {
    predicate: "learning.application",
    subject: "person",
    objects: Object.freeze(["concept"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: null,
    vocabulary_values: null,
  },
  {
    predicate: "learning.demonstration",
    subject: "person",
    objects: Object.freeze(["concept"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: null,
    vocabulary_values: null,
  },
  {
    predicate: "learning.assistance",
    subject: "task_context",
    objects: Object.freeze(["vocabulary"] as const),
    cardinality: "multi",
    polarity: BOTH_POLARITIES,
    max_literal_chars: null,
    vocabulary_values: Object.freeze([
      "learning/assisted",
      "learning/unassisted",
    ] as const),
  },
]);

const WORLD_VOCABULARY_BY_PREDICATE = new Map(
  WORLD_VOCABULARY.map((entry) => [entry.predicate, entry] as const),
);

export function getWorldVocabularySpec(
  predicate: string,
): WorldVocabularySpec | undefined {
  return WORLD_VOCABULARY_BY_PREDICATE.get(
    predicate as WorldVocabularyPredicate,
  );
}

export function isWorldVocabularyPredicate(
  predicate: string,
): predicate is WorldVocabularyPredicate {
  return WORLD_VOCABULARY_BY_PREDICATE.has(
    predicate as WorldVocabularyPredicate,
  );
}
