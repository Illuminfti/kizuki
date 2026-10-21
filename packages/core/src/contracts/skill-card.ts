import { procedureUsefulness, type ProcedureUsefulness } from "./outcome-card";
import { cardCodec, coverage, knownAt, knowledgeNode, relationList, summary,
  type CardKnownAt, type CardSummary, type Coverage, type KnowledgeNode, type Relation } from "./world-card-kit";
export type SkillCard = {
  readonly schema: "kizuki.skill-card/v1";
  readonly skill: KnowledgeNode<"skill">;
  readonly summary: CardSummary | null;
  readonly selfReport: readonly Relation[];
  readonly exposure: readonly Relation[];
  readonly explanation: readonly Relation[];
  readonly application: readonly Relation[];
  readonly observedOutcome: readonly Relation[];
  readonly demonstrations: readonly Relation[];
  readonly about: readonly Relation[];
  readonly outcomes: readonly Relation[];
  readonly lastValidated: readonly Relation[];
  readonly mastery: "unknown";
  readonly taskUsefulness: ProcedureUsefulness;
  readonly knownAt: CardKnownAt;
  readonly coverage: Coverage;
};
export const validateSkillCard = cardCodec<SkillCard, "skill-card">({
  schema: "kizuki.skill-card/v1", label: "skill-card", fields: {
    skill: value => knowledgeNode(value, "skill"), summary,
    selfReport: relationList, exposure: relationList, explanation: relationList, application: relationList, observedOutcome: relationList,
    demonstrations: relationList, about: relationList, outcomes: relationList, lastValidated: relationList,
    mastery: value => value === "unknown", taskUsefulness: procedureUsefulness, knownAt, coverage,
  },
});
