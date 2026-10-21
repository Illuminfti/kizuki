import { isWorldWireToken, type ProcedureCard, type SkillCard, type FrameworkCard, type OutcomeCard } from "@kizuki/core/world";
import { clean } from "../../../output";
import { relationLines } from "./relation-render";
import { KNOWN_OPTIONS, KNOWN_BOUNDS, temporalInput, coverageLine, CURRENT } from "./shared";
import { findQuestionsCli } from "./question";
import type { WorldCliOp } from "./types";
function objectInput(kind: string): Pick<WorldCliOp, "usage" | "options" | "bounds" | "buildInput"> {
  return { usage: "--ref TOKEN [--known-at TIME | --snapshot TOKEN] [--valid-at TIME]", options: ["--ref", ...KNOWN_OPTIONS], bounds: { ...KNOWN_BOUNDS, "--ref": "32-byte base64url object token" },
    buildInput: options => { const token = options.get("--ref"), when = temporalInput(options); return token === undefined || !isWorldWireToken(token) || when === null ? null : { [kind]: { kind: "object", token }, ...when }; } };
}
export const procedureCli: WorldCliOp<ProcedureCard> = { ...objectInput("procedure"), render: data => [
  clean(data.procedure.labels.map(item => item.text).join(" / ")) || "Procedure",
  "Read-only knowledge; execution authority: none.",
  ...data.steps.flatMap(item => relationLines(item.assertion, "Quoted step")),
  ...data.strategy.flatMap(item => relationLines(item, "Strategy")), ...data.successChecks.flatMap(item => relationLines(item, "Success check")),
  ...data.failureModes.flatMap(item => relationLines(item, "Failure mode")),
  ...data.standards.flatMap(item => relationLines(item, "Standard")), ...data.exemplars.flatMap(item => relationLines(item, "Exemplar")),
  ...data.applicability.appliesTo.flatMap(item => relationLines(item, "Applies to")),
  ...data.applicability.prerequisites.flatMap(item => relationLines(item, "Prerequisite")),
  ...data.applicability.requiredCapabilities.flatMap(item => relationLines(item, "Required capability")),
  ...data.applicability.counterexamples.flatMap(item => relationLines(item, "Counterexample")),
  `Evidence strength: ${data.evidenceStrength.assertions.length} attributable assertions; no aggregate score.`,
  `Task usefulness: ${data.taskUsefulness.status === "unknown" ? data.taskUsefulness.reason : data.taskUsefulness.evaluations.map(e => e.result).join(", ")}.`,
  `Freshness: ${data.freshness.status}.`, ...data.freshness.lastValidated.flatMap(item => relationLines(item, "Last validated")), coverageLine(data.coverage),
] };
export const skillCli: WorldCliOp<SkillCard> = { ...objectInput("skill"), render: data => [
  clean(data.skill.labels.map(item => item.text).join(" / ")) || "Skill", `Independent mastery: ${data.mastery}.`,
  ...data.selfReport.flatMap(item => relationLines(item, "Self-report")), ...data.exposure.flatMap(item => relationLines(item, "Exposure")),
  ...data.explanation.flatMap(item => relationLines(item, "Explanation")), ...data.application.flatMap(item => relationLines(item, "Application")),
  ...data.observedOutcome.flatMap(item => relationLines(item, "Independent observed outcome")),
  `Task usefulness: ${data.taskUsefulness.status === "unknown" ? data.taskUsefulness.reason : data.taskUsefulness.evaluations.map(e => e.result).join(", ")}.`,
  ...data.demonstrations.flatMap(item => relationLines(item, "Demonstration")), ...data.about.flatMap(item => relationLines(item, "About")),
  ...data.outcomes.flatMap(item => relationLines(item, "Outcome")), ...data.lastValidated.flatMap(item => relationLines(item, "Last validated")), coverageLine(data.coverage),
] };
export const frameworkCli: WorldCliOp<FrameworkCard> = { ...objectInput("framework"), render: data => [
  clean(data.framework.labels.map(item => item.text).join(" / ")) || "Framework",
  ...data.purpose.flatMap(item => relationLines(item, "Purpose")), ...data.components.flatMap(item => relationLines(item, "Nested component")),
  ...data.assumptions.flatMap(item => relationLines(item, "Assumption")), ...data.applicability.flatMap(item => relationLines(item, "Applicability")),
  ...data.failureModes.flatMap(item => relationLines(item, "Failure mode")), ...data.lifecycle.flatMap(item => relationLines(item, "Adoption evidence")), coverageLine(data.coverage),
] };
export const findProceduresCli = findQuestionsCli;
export const outcomeCli: WorldCliOp<OutcomeCard> = { usage: "--subject SUBJECT", options: ["--subject"], bounds: { "--subject": "outcome subject, at most 256 characters" },
  buildInput: options => { const subject = options.get("--subject"); return subject ? { subject, ...CURRENT } : null; },
  render: data => ["Outcome evidence (quoted data; no execution authority)", ...data.stages.map(item => `${item.stage}: ${JSON.stringify(clean(item.quoted))}; independent: ${item.independent}`),
    ...data.evaluations.map(item => `Result: ${item.result}; goal achieved: ${item.goalAchieved}; independent mastery: ${item.independentMastery}`), coverageLine(data.coverage)],
};
