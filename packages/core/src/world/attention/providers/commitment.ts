import type { SituationCardV2 } from "../../../contracts/situation-card-v2";
import type { SituationCue } from "./situation";

/** Deadline certainty and completion come from the shared Situation v2 reader.
 * Missing, conflicting, vague or unobserved due evidence never becomes urgency. */
export function commitmentCues(card: SituationCardV2): SituationCue[] {
  if (card.objective === null || card.objective.polarity !== "positive" || card.objective.perspective.mode !== "asserted") return [];
  return card.commitments.filter(item => item.overdue === true && ["open", "claimed_done"].includes(item.status)).map(item => ({
    source: "commitment_due", grounds: [card.objective!, ...item.due, ...item.deliverable, ...(item.label === null ? [] : [item.label])],
    detail: { commitment: item.commitment.token, status: item.status },
  }));
}
