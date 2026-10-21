import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";
export const FRAMEWORK_VOCABULARY: WorldVocabularyModule = {
  kind: { id: "framework", vocabularyId: "world/framework", labelPredicate: "framework.label", pageType: "topic", endpointKind: "framework",
    cardSchema: "kizuki.framework-card/v1", offeredToProducer: false, population: ["extraction"] },
  predicates: [
    worldPredicate({ predicate: "framework.label", subject: "framework", objects: ["literal"] }),
    worldPredicate({ predicate: "framework.purpose", subject: "framework", objects: ["literal"] }),
    worldPredicate({ predicate: "framework.includes", subject: "framework", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "framework.component", subject: "framework", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "framework.assumption", subject: "framework", objects: ["literal"] }),
    worldPredicate({ predicate: "framework.applies_to", subject: "framework", objects: ["raw_subject", "literal"] }),
    worldPredicate({ predicate: "framework.failure_mode", subject: "framework", objects: ["literal"] }),
    worldPredicate({ predicate: "framework.lifecycle", subject: "framework", objects: ["vocabulary"], values: ["framework/encountered", "framework/understood", "framework/testing", "framework/adopted", "framework/modified", "framework/rejected", "framework/superseded"] }),
  ],
};
