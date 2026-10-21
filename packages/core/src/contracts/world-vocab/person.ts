import { PERSON_CARD_SCHEMA } from "../person-card";
import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";
export const PERSON_VOCABULARY: WorldVocabularyModule = {
  kind: { id: "person", vocabularyId: "world/person", labelPredicate: "person.label", pageType: "person", endpointKind: "person",
    cardSchema: PERSON_CARD_SCHEMA, offeredToProducer: false, population: ["extraction"] },
  predicates: [
    worldPredicate({ predicate: "person.label", subject: "person", objects: ["literal"] }),
    worldPredicate({ predicate: "person.role", subject: "person", objects: ["literal"] }),
    worldPredicate({ predicate: "relationship.with", subject: "person", objects: ["raw_subject"] }),
  ],
};
