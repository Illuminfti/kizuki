import { isRfc3339 } from "../../util/time";

export function exactCommitmentDue(value: string): boolean {
  return isRfc3339(value) || (/^\d{4}-\d{2}-\d{2}$/.test(value) && isRfc3339(`${value}T00:00:00Z`));
}

import { worldPredicate, type WorldVocabularyModule } from "../world-kinds";
export const COMMITMENT_VOCABULARY: WorldVocabularyModule = {
  kind: { id: "commitment", vocabularyId: "world/commitment", labelPredicate: "commitment.label", pageType: "project",
    endpointKind: "commitment", cardSchema: "kizuki.situation-card/v2", offeredToProducer: false, population: ["extraction"] },
  predicates: [
    worldPredicate({ predicate: "commitment.label", subject: "commitment", objects: ["literal"] }),
    worldPredicate({ predicate: "commitment.debtor", subject: "commitment", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "commitment.creditor", subject: "commitment", objects: ["raw_subject"] }),
    worldPredicate({ predicate: "commitment.due", subject: "commitment", objects: ["literal"] }),
    worldPredicate({ predicate: "commitment.status", subject: "commitment", objects: ["vocabulary"], values: ["commitment/open","commitment/claimed_done","commitment/done","commitment/dropped"] }),
    worldPredicate({ predicate: "commitment.deliverable", subject: "commitment", objects: ["literal","raw_subject"] }),
  ],
};
