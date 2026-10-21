import { validateSkillCard, type SkillCard } from "../../contracts/skill-card";
import { sealCard, type KindAssembler } from "./kit";
export const skillAssembler: KindAssembler = {
  kind: "skill",
  sliceConstraint: relation => ["skill.evidence", "skill.outcome", "skill.last_validated"].includes(relation.predicate),
  assemble({ node, own, summary, coverage, outcomeUsefulness, independentSkillClaims }) {
    const by = (name: string) => own.filter(r => r.predicate === `skill.${name}`);
    const evidence = (kind: string) => by("evidence").filter(r => r.object.kind === "vocabulary" && r.object.id === `skill/${kind}`);
    const independent = new Set(independentSkillClaims);
    const claimedOutcomes = evidence("observed_outcome");
    const card: SkillCard = {
      schema: "kizuki.skill-card/v1", skill: { ...node, kind: "skill" }, summary,
      selfReport: [...evidence("self_report"), ...claimedOutcomes.filter(r => !independent.has(r.claim.token))], exposure: evidence("exposure"), explanation: evidence("explanation"), application: evidence("application"), observedOutcome: claimedOutcomes.filter(r => independent.has(r.claim.token)),
      demonstrations: by("demonstration"), outcomes: by("outcome"), about: by("about"), lastValidated: by("last_validated"),
      mastery: "unknown", taskUsefulness: outcomeUsefulness ?? { status: "unknown", reason: "no_outcome_evidence" }, knownAt: { kind: "current" }, coverage,
    };
    return sealCard(card, validateSkillCard, "skill");
  },
};
