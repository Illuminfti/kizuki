import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";
export const PROCEDURE_VOCABULARY: WorldVocabularyModule = {
  kind: { id: "procedure", vocabularyId: "world/procedure", labelPredicate: "procedure.label", pageType: "topic", endpointKind: "procedure",
    cardSchema: "kizuki.procedure-card/v1", offeredToProducer: false, population: ["extraction"] },
  predicates: [
    worldPredicate({ predicate: "procedure.label", subject: "procedure", objects: ["literal"] }),
    worldPredicate({ predicate: "procedure.step", subject: "procedure", objects: ["literal"] }),
    worldPredicate({ predicate: "procedure.strategy", subject: "procedure", objects: ["literal"] }),
    worldPredicate({ predicate: "procedure.prerequisite", subject: "procedure", objects: ["raw_subject", "literal"] }),
    worldPredicate({ predicate: "procedure.applies_to", subject: "procedure", objects: ["raw_subject", "literal"] }),
    worldPredicate({ predicate: "procedure.required_capability", subject: "procedure", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "procedure.success_check", subject: "procedure", objects: ["literal"] }),
    worldPredicate({ predicate: "procedure.failure_mode", subject: "procedure", objects: ["literal"] }),
    worldPredicate({ predicate: "procedure.counterexample", subject: "procedure", objects: ["literal", "raw_subject"] }),
    worldPredicate({ predicate: "procedure.last_validated", subject: "procedure", objects: ["literal"] }),
    worldPredicate({ predicate: "procedure.outcome", subject: "procedure", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "procedure.standard", subject: "procedure", objects: ["literal"] }),
    worldPredicate({ predicate: "procedure.exemplar", subject: "procedure", objects: ["raw_subject"] }),
  ],
};
