import type { SituationCard } from "../../contracts/situation-card";
import { SITUATION_CARD_V2_SCHEMA, validateSituationCardV2, type SituationCardV2 } from "../../contracts/situation-card-v2";
import { sealCard, type KindAssembler } from "./kit";
import { situationAssembler } from "./situation";
export const situationV2Assembler: KindAssembler = {
  sliceConstraint: relation => /^(commitment\.|situation\.(blocker|commitment|requires|blocks|invalidated_by)$)/.test(relation.predicate),
  kind: "situation", cardSchema: SITUATION_CARD_V2_SCHEMA,
  assemble(input) {
    const base = situationAssembler.assemble(input) as SituationCard;
    const details = input.situationV2;
    if (details === undefined) throw new Error("Situation v2 collection missing");
    const gaps = [...new Set([...base.coverage.gaps,...details.gaps])];
    const card: SituationCardV2 = { ...base, schema: SITUATION_CARD_V2_SCHEMA, commitments: details.commitments,
      statedCommitments: base.commitments, decisions: details.decisions, dependencies: details.dependencies,
      uncertainty: [...new Map([...base.uncertainty,...details.uncertainty].map(r => [r.claim.token,r])).values()],
      coverage: { ...base.coverage, status: gaps.length ? "partial" : "complete_for_query", gaps },
    };
    return sealCard(card,validateSituationCardV2,"situation-v2");
  },
};
