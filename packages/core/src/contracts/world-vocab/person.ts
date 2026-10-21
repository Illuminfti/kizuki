import { PERSON_CARD_SCHEMA } from "../person-card";
import type { ClaimV2Assertion } from "../claim-v2";
import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";
export const PERSON_VOCABULARY: WorldVocabularyModule = {
  kind: { id: "person", vocabularyId: "world/person", labelPredicate: "person.label", pageType: "person", endpointKind: "person",
    cardSchema: PERSON_CARD_SCHEMA, offeredToProducer: false, population: ["extraction"] },
  predicates: [
    worldPredicate({ predicate: "person.label", subject: "person", objects: ["literal"] }),
    worldPredicate({ predicate: "person.role", subject: "person", objects: ["literal"] }),
    worldPredicate({ predicate: "person.interest", subject: "person", objects: ["concept"] }),
    worldPredicate({ predicate: "relationship.with", subject: "person", objects: ["raw_subject"] }),
  ],
};

/** The same conservative boundary applies to new writes and retained admissions. */
export function qualifiedPersonInterest(semantic: ClaimV2Assertion, nativeOwner: boolean): boolean {
  return semantic.subject.kind === "supplied" && semantic.object.kind === "subject" &&
    (nativeOwner || (semantic.perspective.mode === "uncertain" && semantic.perspective.interpretation === "inferred"));
}
