import { isPlainObject } from "../util/validate";
import { isRfc3339 } from "../util/time";
import { cardCodec, coverage, exact, wireRef, type Coverage, type WorldWireRef } from "./world-card-kit";

export const FORECAST_SCHEMA = "kizuki.forecast/v1";
export const FORECAST_SCORES_SCHEMA = "kizuki.forecast-scores/v1";
export const FORECAST_QUESTIONS = ["commitment_met_by_due", "next_independent_inspection_meets_criterion"] as const;
export type ForecastQuestion = typeof FORECAST_QUESTIONS[number];
export type ForecastStatus = "unresolved" | "resolved_met" | "resolved_not_met" | "censored";
export interface ForecastRecord {
  readonly subject: WorldWireRef<"object">;
  readonly question: ForecastQuestion;
  readonly method: "deterministic_dependency";
  readonly class: "prediction" | "analysis";
  readonly frozenAt: string;
  readonly inputs: readonly WorldWireRef<"claim">[];
  readonly probability: number;
  readonly status: ForecastStatus;
  readonly resolvedBy: readonly WorldWireRef<"claim">[];
}
export const FORECAST_BASELINE = Object.freeze({ version:"dependency-v1", interpretation:"uncalibrated_heuristic", model:"none", minimumResolved:20 } as const);
export type Forecast = { readonly baseline: typeof FORECAST_BASELINE; readonly schema: typeof FORECAST_SCHEMA; readonly records: readonly ForecastRecord[]; readonly coverage: Coverage };
type InsufficientHistory = { readonly status: "unavailable"; readonly reason: "insufficient_history" };
export type ForecastScores = {
  readonly schema: typeof FORECAST_SCORES_SCHEMA;
  readonly baseline: typeof FORECAST_BASELINE;
  readonly method: "deterministic_dependency";
  readonly resolved: number;
  readonly unresolved: number;
  readonly censored: number;
  readonly brier: number | InsufficientHistory;
  readonly certainWrong: number;
  readonly cost: { readonly predictions: number; readonly retries: number; readonly maintenance: number; readonly unknown: readonly { readonly metric: string; readonly reason: string }[] };
  readonly usefulness: InsufficientHistory | { readonly status: "observed"; readonly actIfAtLeast: number; readonly netValue: number };
  readonly coverage: Coverage;
};
export const FORECAST_MINIMUM_RESOLVED = 20;
const baseline = (v:unknown) => isPlainObject(v) && exact(v,["version","interpretation","model","minimumResolved"]) && v.version==="dependency-v1" && v.interpretation==="uncalibrated_heuristic" && v.model==="none" && v.minimumResolved===FORECAST_MINIMUM_RESOLVED;
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const refs = (v: unknown) => Array.isArray(v) && v.length <= 256 && v.every(r => wireRef(r,"claim"));
const unavailable = (v: unknown) => isPlainObject(v) && exact(v,["status","reason"]) && v.status === "unavailable" && v.reason === "insufficient_history";
export const validateForecast = cardCodec<Forecast,"forecast">({ schema: FORECAST_SCHEMA, label: "forecast", fields: { baseline,
  records: v => Array.isArray(v) && v.length <= 128 && v.every(r => isPlainObject(r) && exact(r,["subject","question","method","class","frozenAt","inputs","probability","status","resolvedBy"]) &&
    wireRef(r.subject,"object") && FORECAST_QUESTIONS.includes(r.question as ForecastQuestion) && r.method === "deterministic_dependency" && ["prediction","analysis"].includes(String(r.class)) &&
    typeof r.frozenAt === "string" && isRfc3339(r.frozenAt) && refs(r.inputs) && probability(r.probability) && ["unresolved","resolved_met","resolved_not_met","censored"].includes(String(r.status)) && refs(r.resolvedBy)), coverage,
} });
export const validateForecastScores = cardCodec<ForecastScores,"forecast-scores">({ schema: FORECAST_SCORES_SCHEMA, label: "forecast-scores", fields: { baseline,
  method: v => v === "deterministic_dependency", resolved: count, unresolved: count, censored: count, brier: v => probability(v) || unavailable(v), certainWrong: count,
  cost: v => isPlainObject(v) && exact(v,["predictions","retries","maintenance","unknown"]) && [v.predictions,v.retries,v.maintenance].every(count) && Array.isArray(v.unknown) && v.unknown.length <= 8 && v.unknown.every(x => isPlainObject(x) && exact(x,["metric","reason"]) && [x.metric,x.reason].every(t => typeof t === "string" && t.length <= 128)),
  usefulness: v => unavailable(v) || (isPlainObject(v) && exact(v,["status","actIfAtLeast","netValue"]) && v.status === "observed" && probability(v.actIfAtLeast) && typeof v.netValue === "number" && Number.isFinite(v.netValue)), coverage,
} });
