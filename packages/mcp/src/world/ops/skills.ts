import { ABOUT } from "./question";
import { z } from "zod";
import { CURSOR, LABEL, WIRE_TOKEN, WORLD_OBJECT_REF, worldCommon, worldCoverage, worldNode, worldRef, worldRelation } from "./shared";
import type { McpWorldOp } from "./types";
const relations = z.array(worldRelation).max(256);
const outcomeEvidence = z.strictObject({ subjectRef: z.string().min(1).max(128), task: z.string().min(1).max(128), attempt: z.string().min(1).max(128), criterion: z.string().min(1).max(128), artifactVersion: z.string().min(1).max(128), environment: z.string().min(1).max(128), result: z.enum(["met", "not_met", "inconclusive", "acknowledged", "accepted", "rejected", "pending"]), assistance: z.enum(["assisted", "unassisted", "unknown"]), confounded: z.boolean() });
const evaluation = z.strictObject({ report: worldRef("claim"), conditions: outcomeEvidence.nullable(), observations: z.array(worldRef("claim")).max(128), reviews: z.array(worldRef("claim")).max(128), result: z.enum(["met", "not_met", "unknown"]), goalAchieved: z.boolean(), independentMastery: z.boolean() });
const usefulness = z.union([z.strictObject({ status: z.literal("unknown"), reason: z.enum(["no_outcome_evidence", "history"]) }), z.strictObject({ status: z.literal("observed"), evaluations: z.array(evaluation).max(128) })]);
export const procedureFragment: McpWorldOp = { name: "procedure", fields: { procedure: WORLD_OBJECT_REF.optional() },
  data: { "kizuki.procedure-card/v1": { procedure: worldNode("procedure"), ...worldCommon,
    steps: z.array(z.strictObject({ kind: z.literal("quoted"), assertion: worldRelation })).max(256), strategy: relations, successChecks: relations, failureModes: relations, standards: relations, exemplars: relations,
    evidenceStrength: z.strictObject({ assertions: relations }), taskUsefulness: usefulness,
    applicability: z.strictObject({ appliesTo: relations, prerequisites: relations, requiredCapabilities: relations, counterexamples: relations }),
    freshness: z.strictObject({ status: z.enum(["unknown", "recorded"]), lastValidated: relations }), executionAuthority: z.literal("none"), } },
  summary: "procedure: quoted steps, scope, freshness, usefulness; no execution authority.", };
export const findProceduresFragment: McpWorldOp = { name: "find_procedures", fields: { label: LABEL, cursor: CURSOR, about: ABOUT },
  data: { "kizuki.procedure-matches/v1": { matches: z.array(z.strictObject({ ref: WORLD_OBJECT_REF, labels: z.array(z.string().max(400)).max(256) })).max(32), cursor: WIRE_TOKEN.nullable(), coverage: worldCoverage } },
  summary: "find_procedures: label/about pages; retrieval cannot raise confidence.", };
export const skillFragment: McpWorldOp = { name: "skill", fields: { skill: WORLD_OBJECT_REF.optional() },
  data: { "kizuki.skill-card/v1": { skill: worldNode("skill"), ...worldCommon, selfReport: relations, exposure: relations, explanation: relations, application: relations, observedOutcome: relations,
    demonstrations: relations, about: relations, outcomes: relations, lastValidated: relations, mastery: z.literal("unknown"), taskUsefulness: usefulness } },
  summary: "skill separates learning evidence; independent mastery stays unknown.", };
export const frameworkFragment: McpWorldOp = { name: "framework", fields: { framework: WORLD_OBJECT_REF.optional() },
  data: { "kizuki.framework-card/v1": { framework: worldNode("framework"), ...worldCommon, purpose: relations, components: relations, assumptions: relations, applicability: relations, failureModes: relations, lifecycle: relations } },
  summary: "framework: nested components/adoption; no cycles.", };

export const outcomeFragment: McpWorldOp = { name: "outcome", fields: { subject: z.string().min(1).max(256).optional() },
  data: { "kizuki.outcome-card/v1": { stages: z.array(z.strictObject({ claim: worldRef("claim"), stage: z.enum(["agent_reported", "provider_acknowledged", "observed", "reviewed"]), evidence: outcomeEvidence.nullable(), quoted: z.string().max(1024), independent: z.boolean() })).max(128), evaluations: z.array(evaluation).max(128), goalAchieved: z.boolean(), coverage: worldCoverage } },
  summary: "outcome separates four stages; achievement needs matched independent evidence.", };
