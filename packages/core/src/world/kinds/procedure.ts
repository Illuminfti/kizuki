import { validateProcedureCard, type ProcedureCard } from "../../contracts/procedure-card";
import { sealCard, type KindAssembler } from "./kit";
export const procedureAssembler: KindAssembler = {
  kind: "procedure",
  sliceConstraint: relation => ["procedure.step", "procedure.prerequisite", "procedure.required_capability", "procedure.failure_mode", "procedure.counterexample", "procedure.success_check", "procedure.standard"].includes(relation.predicate),
  assemble({ node, own, summary, coverage, outcomeUsefulness }) {
    const by = (name: string) => own.filter(r => r.predicate === `procedure.${name}`);
    const lastValidated = by("last_validated");
    const ordinal = (r: typeof own[number]) => r.object.kind === "literal" ? Number(/^([1-9][0-9]{0,2})\. /.exec(r.object.value)?.[1] ?? Infinity) : Infinity;
    const steps = by("step").sort((a, b) => ordinal(a) - ordinal(b) || a.claim.token.localeCompare(b.claim.token));
    const card: ProcedureCard = {
      schema: "kizuki.procedure-card/v1", procedure: { ...node, kind: "procedure" }, summary,
      steps: steps.map(assertion => ({ kind: "quoted", assertion })), strategy: by("strategy"), successChecks: by("success_check"), failureModes: by("failure_mode"),
      standards: by("standard"), exemplars: by("exemplar"), evidenceStrength: { assertions: own },
      taskUsefulness: outcomeUsefulness ?? { status: "unknown", reason: "no_outcome_evidence" },
      applicability: { appliesTo: by("applies_to"), prerequisites: by("prerequisite"), requiredCapabilities: by("required_capability"), counterexamples: by("counterexample") },
      freshness: { status: lastValidated.length > 0 ? "recorded" : "unknown", lastValidated }, executionAuthority: "none", knownAt: { kind: "current" }, coverage,
    };
    return sealCard(card, validateProcedureCard, "procedure");
  },
};
