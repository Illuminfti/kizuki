import { QUESTION_CARD_SCHEMA } from "../question-card";
import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";

export const QUESTION_STATUSES = ["open", "partial", "resolved", "reopened", "abandoned"] as const;
export const GAP_KINDS = ["missing_prerequisite", "unresolved_question", "contradiction", "stale_evidence", "misconception", "lack_of_practice", "missing_information"] as const;

export const QUESTION_VOCABULARY: WorldVocabularyModule = {
  kind: {
    id: "question", vocabularyId: "world/question", labelPredicate: "question.text",
    pageType: "topic", endpointKind: "question", cardSchema: QUESTION_CARD_SCHEMA,
    offeredToProducer: false, population: ["extraction"],
  },
  predicates: [
    worldPredicate({ predicate: "question.text", subject: "question", objects: ["literal"] }),
    worldPredicate({ predicate: "question.status", subject: "question", objects: ["vocabulary"], values: QUESTION_STATUSES.map(status => `question/${status}`) }),
    worldPredicate({ predicate: "question.candidate_answer", subject: "question", objects: ["literal", "raw_subject"] }),
    worldPredicate({ predicate: "question.motivates", subject: "question", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "gap.kind", subject: "question", objects: ["vocabulary"], values: GAP_KINDS.map(kind => `gap/${kind}`) }),
    worldPredicate({ predicate: "gap.about", subject: "question", objects: ["raw_subject"] }),
  ],
};
