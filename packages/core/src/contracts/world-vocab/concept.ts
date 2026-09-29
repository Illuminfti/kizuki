import { CONCEPT_CARD_SCHEMA } from "../concept-card";
import { worldPredicate, type WorldObjectKind, type WorldVocabularyModule } from "../world-kinds";

const concept = (predicate: string, objects: readonly WorldObjectKind[]) =>
  worldPredicate({ predicate, subject: "concept", objects });

export const CONCEPT_VOCABULARY: WorldVocabularyModule = {
  kind: {
    id: "concept",
    vocabularyId: "world/concept",
    labelPredicate: "concept.label",
    pageType: "topic",
    endpointKind: "concept",
    cardSchema: CONCEPT_CARD_SCHEMA,
    offeredToProducer: true,
    population: ["extraction"],
  },
  predicates: [
    concept("concept.label", ["literal"]),
    concept("concept.definition", ["literal"]),
    concept("concept.requires", ["concept"]),
    concept("concept.example", ["literal", "raw_subject"]),
    concept("concept.counterexample", ["literal", "raw_subject"]),
    concept("concept.distinguished_from", ["concept"]),
  ],
};
