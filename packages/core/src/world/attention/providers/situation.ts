import type { AttentionSource } from "../../../contracts/attention";
import type { Relation } from "../../../contracts/world-card-kit";
import type { SituationCard } from "../../../contracts/situation-card";

export interface SituationCue {
  readonly source: AttentionSource;
  readonly grounds: readonly Relation[];
}
/** Explicit goals supply relevance. Repetition and retrieval are never inputs. */
export function situationCues(card: SituationCard): SituationCue[] {
  if (card.objective === null || card.objective.polarity !== "positive" || card.objective.perspective.mode !== "asserted") return [];
  const cues: SituationCue[] = [];
  if (card.blocker !== null) cues.push({ source: "blocker", grounds: [card.objective, card.blocker] });
  const uncertainty = card.uncertainty.filter(row => ["situation.objective", "situation.blocker", "situation.change"].includes(row.predicate));
  if (uncertainty.length > 0) cues.push({ source: "uncertainty", grounds: [card.objective, ...uncertainty] });
  if (card.coverage.gaps.includes("stale_dependencies")) cues.push({ source: "stale_summary", grounds: [card.objective] });
  return cues;
}
