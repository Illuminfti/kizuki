import { validateFrameworkCard, type FrameworkCard } from "../../contracts/framework-card";
import { sealCard, type KindAssembler } from "./kit";
export const frameworkAssembler: KindAssembler = {
  kind: "framework",
  sliceConstraint: relation => ["framework.assumption", "framework.applies_to", "framework.failure_mode", "framework.lifecycle"].includes(relation.predicate),
  assemble({ node, own, summary, coverage }) {
    const by = (name: string) => own.filter(r => r.predicate === `framework.${name}`);
    const card: FrameworkCard = {
      schema: "kizuki.framework-card/v1", framework: { ...node, kind: "framework" }, summary,
      purpose: by("purpose"), components: [...by("includes"), ...by("component")], assumptions: by("assumption"), applicability: by("applies_to"),
      failureModes: by("failure_mode"), lifecycle: by("lifecycle"), knownAt: { kind: "current" }, coverage,
    };
    return sealCard(card, validateFrameworkCard, "framework");
  },
};
