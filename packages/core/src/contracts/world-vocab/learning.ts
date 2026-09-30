import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";

const facet = (predicate: string) => worldPredicate({ predicate, subject: "person", objects: ["concept"] });

/** What a person has done with a concept. It adds predicates and owns no kind. */
export const LEARNING_VOCABULARY: WorldVocabularyModule = {
  kind: null,
  offeredToProducer: true,
  predicates: [
    facet("learning.exposure"),
    facet("learning.explanation"),
    facet("learning.application"),
    facet("learning.demonstration"),
    worldPredicate({
      predicate: "learning.assistance",
      subject: "task_context",
      objects: ["vocabulary"],
      values: ["learning/assisted", "learning/unassisted"],
    }),
  ],
};
