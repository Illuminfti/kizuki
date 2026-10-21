import { cardCodec, coverage, knownAt, knowledgeNode, relationList, summary,
  type CardKnownAt, type CardSummary, type Coverage, type KnowledgeNode, type Relation } from "./world-card-kit";
export type FrameworkCard = {
  readonly schema: "kizuki.framework-card/v1";
  readonly framework: KnowledgeNode<"framework">;
  readonly summary: CardSummary | null;
  readonly purpose: readonly Relation[];
  readonly components: readonly Relation[];
  readonly assumptions: readonly Relation[];
  readonly applicability: readonly Relation[];
  readonly failureModes: readonly Relation[];
  readonly lifecycle: readonly Relation[];
  readonly knownAt: CardKnownAt;
  readonly coverage: Coverage;
};
export const validateFrameworkCard = cardCodec<FrameworkCard, "framework-card">({
  schema: "kizuki.framework-card/v1", label: "framework-card", fields: {
    framework: value => knowledgeNode(value, "framework"), summary,
    purpose: relationList, components: relationList, assumptions: relationList, applicability: relationList, failureModes: relationList, lifecycle: relationList,
    knownAt, coverage,
  },
});
