import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";
export const SITUATION_V2_VOCABULARY: WorldVocabularyModule = {
  kind: null, offeredToProducer: false,
  predicates: ["situation.has_commitment", "situation.has_decision", "situation.requires", "situation.enables", "situation.blocks", "situation.invalidated_by"].map(predicate =>
    worldPredicate({ predicate, subject: "situation", objects: predicate === "situation.invalidated_by" ? ["raw_subject","literal"] : ["raw_subject"] })),
};
