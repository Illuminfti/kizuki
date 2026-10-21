import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";
export const SKILL_VOCABULARY: WorldVocabularyModule = {
  kind: { id: "skill", vocabularyId: "world/skill", labelPredicate: "skill.label", pageType: "topic", endpointKind: "skill",
    cardSchema: "kizuki.skill-card/v1", offeredToProducer: false, population: ["extraction"] },
  predicates: [
    worldPredicate({ predicate: "skill.label", subject: "skill", objects: ["literal"] }),
    worldPredicate({ predicate: "skill.evidence", subject: "skill", objects: ["vocabulary"], values: ["skill/self_report", "skill/exposure", "skill/explanation", "skill/application", "skill/observed_outcome"] }),
    worldPredicate({ predicate: "skill.about", subject: "skill", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "skill.demonstration", subject: "skill", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "skill.outcome", subject: "skill", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "skill.last_validated", subject: "skill", objects: ["literal"] }),
  ],
};
