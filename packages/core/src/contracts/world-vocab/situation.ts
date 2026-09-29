import { SITUATION_CARD_SCHEMA } from "../situation-card";
import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";

const literal = (predicate: string) => worldPredicate({ predicate, subject: "situation", objects: ["literal"] });

export const SITUATION_VOCABULARY: WorldVocabularyModule = {
  kind: {
    id: "situation",
    vocabularyId: "world/situation",
    labelPredicate: "situation.label",
    pageType: "project",
    endpointKind: "situation",
    cardSchema: SITUATION_CARD_SCHEMA,
    offeredToProducer: true,
    population: ["extraction"],
  },
  predicates: [
    literal("situation.label"),
    literal("situation.objective"),
    literal("situation.commitment"),
    literal("situation.blocker"),
    literal("situation.change"),
    worldPredicate({ predicate: "situation.participant", subject: "situation", objects: ["raw_subject"] }),
  ],
};
