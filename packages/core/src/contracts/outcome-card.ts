import { isPlainObject } from "../util/validate";
import { cardCodec, coverage, exact, wireRef, type Coverage, type WorldWireRef } from "./world-card-kit";

export const OUTCOME_PREDICATES = ["outcome.self_report", "outcome.provider_ack", "outcome.observation", "outcome.review"] as const;
export type OutcomePredicate = typeof OUTCOME_PREDICATES[number];
/** Matching all of these pins is required before an observation/review evaluates a report. */
export interface OutcomeEvidence {
  readonly subjectRef: string;
  readonly task: string;
  readonly attempt: string;
  readonly criterion: string;
  readonly artifactVersion: string;
  readonly environment: string;
  readonly result: string;
  readonly assistance: "assisted" | "unassisted" | "unknown";
  readonly confounded: boolean;
}
const RESULTS: Record<OutcomePredicate, readonly string[]> = {
  "outcome.self_report": ["met", "not_met", "inconclusive"],
  "outcome.provider_ack": ["acknowledged"],
  "outcome.observation": ["met", "not_met", "inconclusive"],
  "outcome.review": ["accepted", "rejected", "pending"],
};
export function parseOutcomeEvidence(predicate: string, input: unknown): OutcomeEvidence | null {
  if (!OUTCOME_PREDICATES.includes(predicate as OutcomePredicate) || typeof input !== "string" || input.length > 1024) return null;
  let value: unknown; try { value = JSON.parse(input); } catch { return null; }
  if (!isPlainObject(value) || !exact(value, ["subjectRef", "task", "attempt", "criterion", "artifactVersion", "environment", "result", "assistance", "confounded"]) ||
    !["subjectRef", "task", "attempt", "criterion", "artifactVersion", "environment"].every(key => typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 128) ||
    typeof value.result !== "string" || !RESULTS[predicate as OutcomePredicate].includes(value.result) ||
    typeof value.assistance !== "string" || !["assisted", "unassisted", "unknown"].includes(value.assistance) || typeof value.confounded !== "boolean") return null;
  return value as unknown as OutcomeEvidence;
}
/** Submission-only extension. Stored binding tags are never accepted from callers. */
export type OutcomeSubmission = Omit<OutcomeEvidence, "artifactVersion"> & {
  readonly artifactVersion: string | WorldWireRef<"object">;
};
export function parseOutcomeSubmission(predicate: string, input: unknown): OutcomeSubmission | null {
  const legacy = parseOutcomeEvidence(predicate, input);
  if (legacy !== null) return legacy;
  if (typeof input !== "string" || input.length > 1024) return null;
  let value: unknown; try { value = JSON.parse(input); } catch { return null; }
  if (!isPlainObject(value) || !wireRef(value.artifactVersion, "object")) return null;
  const checked = parseOutcomeEvidence(predicate, JSON.stringify({ ...value, artifactVersion: "bound" }));
  return checked === null ? null : { ...checked, artifactVersion: value.artifactVersion as WorldWireRef<"object"> };
}
export interface OutcomeStage {
  readonly claim: WorldWireRef<"claim">;
  readonly stage: "agent_reported" | "provider_acknowledged" | "observed" | "reviewed";
  readonly evidence: OutcomeEvidence | null;
  readonly quoted: string;
  readonly independent: boolean;
}
export interface OutcomeEvaluation {
  readonly report: WorldWireRef<"claim">;
  readonly conditions: OutcomeEvidence | null;
  readonly observations: readonly WorldWireRef<"claim">[];
  readonly reviews: readonly WorldWireRef<"claim">[];
  readonly result: "met" | "not_met" | "unknown";
  readonly goalAchieved: boolean;
  readonly independentMastery: boolean;
}
export type OutcomeCard = {
  readonly schema: "kizuki.outcome-card/v1";
  readonly stages: readonly OutcomeStage[];
  readonly evaluations: readonly OutcomeEvaluation[];
  readonly goalAchieved: boolean;
  readonly coverage: Coverage;
};
export type ProcedureUsefulness =
  | { readonly status: "unknown"; readonly reason: "no_outcome_evidence" | "history" }
  | { readonly status: "observed"; readonly evaluations: readonly OutcomeEvaluation[] };
export function outcomeEvaluation(value: unknown): boolean {
  return isPlainObject(value) && exact(value, ["report", "conditions", "observations", "reviews", "result", "goalAchieved", "independentMastery"]) &&
    wireRef(value.report, "claim") && (value.conditions === null || parseOutcomeEvidence("outcome.self_report", JSON.stringify(value.conditions)) !== null) && [value.observations, value.reviews].every(items => Array.isArray(items) && items.length <= 128 && items.every(ref => wireRef(ref, "claim"))) &&
    typeof value.result === "string" && ["met", "not_met", "unknown"].includes(value.result) && typeof value.goalAchieved === "boolean" && typeof value.independentMastery === "boolean";
}
export function procedureUsefulness(value: unknown): boolean {
  return isPlainObject(value) && (exact(value, ["status", "reason"]) && value.status === "unknown" && ["no_outcome_evidence", "history"].includes(String(value.reason)) ||
    exact(value, ["status", "evaluations"]) && value.status === "observed" && Array.isArray(value.evaluations) && value.evaluations.length <= 128 && value.evaluations.every(outcomeEvaluation));
}
export const validateOutcomeCard = cardCodec<OutcomeCard, "outcome-card">({
  schema: "kizuki.outcome-card/v1", label: "outcome-card", fields: {
    stages: value => Array.isArray(value) && value.length <= 128 && value.every(item => isPlainObject(item) && exact(item, ["claim", "stage", "evidence", "quoted", "independent"]) &&
      wireRef(item.claim, "claim") && ["agent_reported", "provider_acknowledged", "observed", "reviewed"].includes(String(item.stage)) &&
      typeof item.quoted === "string" && item.quoted.length <= 1024 && typeof item.independent === "boolean" &&
      (item.evidence === null || parseOutcomeEvidence(({ agent_reported: "outcome.self_report", provider_acknowledged: "outcome.provider_ack", observed: "outcome.observation", reviewed: "outcome.review" } as Record<string, string>)[String(item.stage)]!, JSON.stringify(item.evidence)) !== null)),
    evaluations: value => Array.isArray(value) && value.length <= 128 && value.every(outcomeEvaluation), goalAchieved: value => typeof value === "boolean", coverage,
  },
});
