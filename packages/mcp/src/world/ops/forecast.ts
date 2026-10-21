import { z } from "zod";
import { WORLD_OBJECT_REF, worldCoverage } from "./shared";
import type { McpWorldOp } from "./types";
const claim=z.strictObject({kind:z.literal("claim"),token:WORLD_OBJECT_REF.shape.token});
const baseline=z.strictObject({version:z.literal("dependency-v1"),interpretation:z.literal("uncalibrated_heuristic"),model:z.literal("none"),minimumResolved:z.literal(20)});
const unavailable=z.strictObject({status:z.literal("unavailable"),reason:z.literal("insufficient_history")});
const probability=z.number().min(0).max(1);
export const forecastFragment:McpWorldOp={name:"forecast",fields:{commitment:WORLD_OBJECT_REF.optional()},data:{"kizuki.forecast/v1":{
  baseline,records:z.array(z.strictObject({subject:WORLD_OBJECT_REF,question:z.enum(["commitment_met_by_due","next_independent_inspection_meets_criterion"]),method:z.literal("deterministic_dependency"),class:z.enum(["prediction","analysis"]),
    frozenAt:z.string().max(40),inputs:z.array(claim).max(256),probability,status:z.enum(["unresolved","resolved_met","resolved_not_met","censored"]),resolvedBy:z.array(claim).max(256)})).max(128),coverage:worldCoverage,
}},summary:"forecast reads frozen commitment predictions and separately labelled analysis. dependency-v1 is an uncalibrated fixed heuristic (0.25 for a later-due prerequisite, otherwise 0.5), makes no model call, and grants no execution authority. Later evidence cannot rewrite a prediction or its first independent resolution."};
export const forecastScoresFragment:McpWorldOp={name:"forecast_scores",fields:{},data:{"kizuki.forecast-scores/v1":{
  baseline,method:z.literal("deterministic_dependency"),resolved:z.number().int().min(0),unresolved:z.number().int().min(0),censored:z.number().int().min(0),brier:z.union([probability,unavailable]),certainWrong:z.number().int().min(0),
  cost:z.strictObject({predictions:z.number().int().min(0),retries:z.number().int().min(0),maintenance:z.number().int().min(0),unknown:z.array(z.strictObject({metric:z.string().max(128),reason:z.string().max(128)})).max(8)}),
  usefulness:z.union([unavailable,z.strictObject({status:z.literal("observed"),actIfAtLeast:probability,netValue:z.number()})]),coverage:worldCoverage,
}},summary:"forecast_scores reports currently authorized prediction records, excluding analysis, and is unavailable(history) below 20 resolved predictions. 20 is a fixed reporting gate, not statistical sufficiency. Unknown outcomes never count as success; score, unresolved counts, computational cost and task usefulness remain separate."};
