import { isPlainObject } from "../util/validate";
import { cardCodec, coverage, exact, knownAt, knowledgeNode, relationList, summary,
  type CardKnownAt, type CardSummary, type Coverage, type KnowledgeNode, type Relation } from "./world-card-kit";
import { procedureUsefulness, type ProcedureUsefulness } from "./outcome-card";
export type ProcedureCard = {
  readonly schema: "kizuki.procedure-card/v1";
  readonly procedure: KnowledgeNode<"procedure">;
  readonly summary: CardSummary | null;
  readonly steps: readonly { readonly kind: "quoted"; readonly assertion: Relation }[];
  readonly strategy: readonly Relation[];
  readonly successChecks: readonly Relation[];
  readonly failureModes: readonly Relation[];
  readonly standards: readonly Relation[];
  readonly exemplars: readonly Relation[];
  readonly evidenceStrength: { readonly assertions: readonly Relation[] };
  readonly taskUsefulness: ProcedureUsefulness;
  readonly applicability: { readonly appliesTo: readonly Relation[]; readonly prerequisites: readonly Relation[]; readonly requiredCapabilities: readonly Relation[]; readonly counterexamples: readonly Relation[] };
  readonly freshness: { readonly status: "unknown" | "recorded"; readonly lastValidated: readonly Relation[] };
  readonly executionAuthority: "none";
  readonly knownAt: CardKnownAt;
  readonly coverage: Coverage;
};
export const validateProcedureCard = cardCodec<ProcedureCard, "procedure-card">({
  schema: "kizuki.procedure-card/v1", label: "procedure-card", fields: {
    procedure: value => knowledgeNode(value, "procedure"), summary,
    steps: value => Array.isArray(value) && value.length <= 256 && value.every(item => isPlainObject(item) && exact(item, ["kind", "assertion"]) && item.kind === "quoted" && relationList([item.assertion])),
    strategy: relationList, successChecks: relationList, failureModes: relationList, standards: relationList, exemplars: relationList,
    evidenceStrength: value => isPlainObject(value) && exact(value, ["assertions"]) && relationList(value.assertions), taskUsefulness: procedureUsefulness,
    applicability: value => isPlainObject(value) && exact(value, ["appliesTo", "prerequisites", "requiredCapabilities", "counterexamples"]) && Object.values(value).every(relationList),
    freshness: value => isPlainObject(value) && exact(value, ["status", "lastValidated"]) && (value.status === "unknown" || value.status === "recorded") && relationList(value.lastValidated),
    executionAuthority: value => value === "none", knownAt, coverage,
  },
});
