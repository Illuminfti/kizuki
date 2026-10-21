import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";
export const DECISION_VOCABULARY: WorldVocabularyModule = {
  kind: { id: "decision", vocabularyId: "world/decision", labelPredicate: "decision.label", pageType: "project",
    endpointKind: "decision", cardSchema: "kizuki.situation-card/v2", offeredToProducer: false, population: ["extraction"] },
  predicates: [
    worldPredicate({ predicate: "decision.label", subject: "decision", objects: ["literal"] }),
    worldPredicate({ predicate: "decision.status", subject: "decision", objects: ["vocabulary"], values: ["decision/open","decision/decided","decision/reversed"] }),
  ],
};
