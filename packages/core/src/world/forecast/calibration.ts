import type { Database } from "bun:sqlite";
import type { Sensitivity } from "../../agents/types";
import {
  FORECAST_MINIMUM_RESOLVED,
  type ForecastQuestion,
  type ForecastStatus,
} from "../../contracts/forecast";
import { tableExists } from "../../ledger/schema";
import { isPlainObject } from "../../util/validate";
import type { ForecastConditions } from "./basis";
import { parseForecastProof, type ForecastProof } from "./proof";
import type { ForecastRow, ResolutionRow } from "./store";

export const CALIBRATION_METHOD = "beta_binomial_v1" as const;
export const CALIBRATION_PRIOR_STRENGTH = 4;
export const CALIBRATION_MIN_PROBABILITY = 0.05;
export const CALIBRATION_MAX_PROBABILITY = 0.95;
export const CALIBRATION_DEFAULT_BINS = 10;

const SENSITIVITY_RANK: Readonly<Record<Sensitivity, number>> = {
  public: 0,
  personal: 1,
  private: 2,
};

export interface ForecastCalibrationSnapshot {
  readonly method: typeof CALIBRATION_METHOD;
  readonly priorMean: number;
  readonly priorStrength: number;
  readonly resolvedCount: number;
  readonly metCount: number;
  readonly totalResolved: number;
  readonly probability: number;
}

export interface StoredForecastConditions {
  readonly report?: string;
  readonly expected?: ForecastConditions["expected"];
  readonly calibration?: ForecastCalibrationSnapshot;
}

export interface ReliabilityBin {
  readonly binIndex: number;
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanProbability: number;
  readonly observedRate: number;
  readonly absGap: number;
}

export interface ForecastCalibrationMetrics {
  readonly total: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly censored: number;
  readonly met: number;
  readonly notMet: number;
  readonly brier: number | null;
  readonly climatology: number | null;
  readonly climatologyBrier: number | null;
  readonly brierSkillScore: number | null;
  readonly ece: number | null;
  readonly reliability: number | null;
  readonly resolution: number | null;
  readonly uncertainty: number | null;
  readonly sharpness: number | null;
  readonly certainWrong: number;
  readonly bins: readonly ReliabilityBin[];
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Deterministic Beta-Binomial posterior mean clamped to [0.05, 0.95]. */
export function calibratedProbability(
  priorMean: number,
  priorStrength: number,
  metCount: number,
  resolvedCount: number,
): number {
  const alpha0 = priorMean * priorStrength;
  const raw = (alpha0 + metCount) / (priorStrength + resolvedCount);
  const clamped = Math.min(CALIBRATION_MAX_PROBABILITY, Math.max(CALIBRATION_MIN_PROBABILITY, raw));
  return round6(clamped);
}

const CALIBRATION_KEYS = [
  "method",
  "metCount",
  "priorMean",
  "priorStrength",
  "probability",
  "resolvedCount",
  "totalResolved",
].sort().join(",");

export function parseForecastCalibration(value: unknown): ForecastCalibrationSnapshot | null {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== CALIBRATION_KEYS) return null;
  if (
    value.method !== CALIBRATION_METHOD ||
    (value.priorMean !== 0.25 && value.priorMean !== 0.5) ||
    value.priorStrength !== CALIBRATION_PRIOR_STRENGTH ||
    typeof value.totalResolved !== "number" ||
    !Number.isSafeInteger(value.totalResolved) ||
    value.totalResolved < FORECAST_MINIMUM_RESOLVED ||
    typeof value.resolvedCount !== "number" ||
    !Number.isSafeInteger(value.resolvedCount) ||
    value.resolvedCount < 1 ||
    value.resolvedCount > value.totalResolved ||
    typeof value.metCount !== "number" ||
    !Number.isSafeInteger(value.metCount) ||
    value.metCount < 0 ||
    value.metCount > value.resolvedCount ||
    typeof value.probability !== "number" ||
    !Number.isFinite(value.probability)
  ) {
    return null;
  }
  const expected = calibratedProbability(
    value.priorMean,
    value.priorStrength,
    value.metCount,
    value.resolvedCount,
  );
  if (value.probability !== expected) return null;
  return {
    method: CALIBRATION_METHOD,
    priorMean: value.priorMean,
    priorStrength: value.priorStrength,
    resolvedCount: value.resolvedCount,
    metCount: value.metCount,
    totalResolved: value.totalResolved,
    probability: value.probability,
  };
}

export function mergeForecastConditions(
  base: ForecastConditions | null,
  calibration: ForecastCalibrationSnapshot | null,
): ForecastConditions | StoredForecastConditions | null {
  if (calibration === null) return base;
  if (base === null) return { calibration };
  return { report: base.report, expected: base.expected, calibration };
}

export function stripCalibrationFromConditions(raw: string | null): ForecastConditions | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || typeof parsed.report !== "string" || parsed.expected === undefined) {
    return null;
  }
  return { report: parsed.report, expected: parsed.expected as ForecastConditions["expected"] };
}

function asSensitivity(value: string | null | undefined): Sensitivity {
  if (value === "public" || value === "personal" || value === "private") return value;
  return "private";
}

function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b;
}

/** Strictest sensitivity across the frozen claim proofs of a target commitment. */
export function targetProofsCeiling(db: Database, proofs: readonly ForecastProof[]): Sensitivity {
  let ceiling: Sensitivity = "public";
  const query = db.query<{ sensitivity: string }, [string]>(
    "SELECT sensitivity FROM claims WHERE claim_id=?",
  );
  for (const proof of proofs) {
    const row = query.get(proof.claim);
    if (row !== null) ceiling = maxSensitivity(ceiling, asSensitivity(row.sensitivity));
  }
  return ceiling;
}

function proofsWithinCeiling(
  db: Database,
  proofs: readonly ForecastProof[],
  ceiling: Sensitivity,
  hasSourceGrants: boolean,
): boolean {
  const claimQuery = db.query<{ status: string; sensitivity: string }, [string]>(
    "SELECT status, sensitivity FROM claims WHERE claim_id=?",
  );
  const grantQuery = hasSourceGrants
    ? db.query<{ status: string; policy: string }, [string]>(
        "SELECT status, policy FROM source_grants WHERE source_key=?",
      )
    : null;
  for (const proof of proofs) {
    const claim = claimQuery.get(proof.claim);
    if (claim === null || claim.status !== "live") return false;
    if (SENSITIVITY_RANK[asSensitivity(claim.sensitivity)] > SENSITIVITY_RANK[ceiling]) return false;
    if (grantQuery !== null) {
      for (const source of proof.sources) {
        const grant = grantQuery.get(source);
        if (grant === null || grant.status !== "active") return false;
        let parsed: { purposes?: unknown; sensitivity_floor?: unknown };
        try {
          parsed = JSON.parse(grant.policy) as { purposes?: unknown; sensitivity_floor?: unknown };
        } catch {
          return false;
        }
        const purposes = Array.isArray(parsed.purposes) ? parsed.purposes : [];
        if (!purposes.includes("derive") && !purposes.includes("recall")) return false;
        if (SENSITIVITY_RANK[asSensitivity(String(parsed.sensitivity_floor ?? "private"))] > SENSITIVITY_RANK[ceiling]) {
          return false;
        }
      }
    }
  }
  return true;
}

function priorHadLaterPrerequisite(row: Pick<ForecastRow, "probability" | "conditions">): boolean {
  if (row.conditions !== null) {
    try {
      const parsed = JSON.parse(row.conditions) as { calibration?: unknown };
      const cal = parseForecastCalibration(parsed?.calibration);
      if (cal !== null) return cal.priorMean === 0.25;
    } catch {
      // Fall back to baseline probability when conditions JSON is absent or uncalibrated.
    }
  }
  return row.probability === 0.25;
}

/**
 * Derive an authorization- and sensitivity-contained empirical calibration
 * snapshot from prior resolved predictions with `recorded_sequence <= maxSequence`.
 * Returns null below `FORECAST_MINIMUM_RESOLVED` (20) so cold-start vaults
 * remain on the exact uncalibrated `dependency-v1` baseline.
 */
export function deriveLiveCalibration(
  db: Database,
  options: {
    readonly question: ForecastQuestion;
    readonly laterPrerequisite: boolean;
    readonly ceiling: Sensitivity;
    readonly maxSequence: number;
  },
): ForecastCalibrationSnapshot | null {
  const rows = db
    .query<
      Pick<ForecastRow, "forecast_id" | "question" | "probability" | "conditions"> &
        Pick<ResolutionRow, "status" | "proof">,
      [number]
    >(
      `SELECT f.forecast_id, f.question, f.probability, f.conditions, r.status, r.proof
         FROM world_forecasts f
         JOIN world_forecast_resolutions r USING(forecast_id)
        WHERE f.record_class = 'prediction'
          AND r.status IN ('resolved_met', 'resolved_not_met')
          AND r.recorded_sequence <= ?
        ORDER BY r.recorded_sequence, f.forecast_id`,
    )
    .all(options.maxSequence);

  if (rows.length < FORECAST_MINIMUM_RESOLVED) return null;

  const hasSourceGrants = tableExists(db, "source_grants");
  const inputQuery = db.query<{ proof: string }, [string]>(
    "SELECT proof FROM world_forecast_inputs WHERE forecast_id=? ORDER BY claim_id",
  );

  let totalResolved = 0;
  let resolvedCount = 0;
  let metCount = 0;

  for (const row of rows) {
    const rawInputs = inputQuery.all(row.forecast_id);
    if (rawInputs.length === 0) continue;
    const inputProofs: ForecastProof[] = [];
    let valid = true;
    for (const item of rawInputs) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(item.proof);
      } catch {
        valid = false;
        break;
      }
      const proof = parseForecastProof(parsed);
      if (proof === null) {
        valid = false;
        break;
      }
      inputProofs.push(proof);
    }
    if (!valid) continue;

    let rawRes: unknown;
    try {
      rawRes = JSON.parse(row.proof);
    } catch {
      continue;
    }
    if (!Array.isArray(rawRes) || rawRes.length === 0) continue;
    const resProofs = rawRes.map(parseForecastProof);
    if (resProofs.some((p) => p === null)) continue;

    if (
      !proofsWithinCeiling(db, inputProofs, options.ceiling, hasSourceGrants) ||
      !proofsWithinCeiling(db, resProofs as ForecastProof[], options.ceiling, hasSourceGrants)
    ) {
      continue;
    }

    totalResolved += 1;
    if (
      row.question === options.question &&
      priorHadLaterPrerequisite(row) === options.laterPrerequisite
    ) {
      resolvedCount += 1;
      if (row.status === "resolved_met") metCount += 1;
    }
  }

  if (totalResolved < FORECAST_MINIMUM_RESOLVED || resolvedCount === 0) return null;
  const priorMean = options.laterPrerequisite ? 0.25 : 0.5;
  return {
    method: CALIBRATION_METHOD,
    priorMean,
    priorStrength: CALIBRATION_PRIOR_STRENGTH,
    resolvedCount,
    metCount,
    totalResolved,
    probability: calibratedProbability(
      priorMean,
      CALIBRATION_PRIOR_STRENGTH,
      metCount,
      resolvedCount,
    ),
  };
}

/**
 * Compute Brier score, climatology, Brier Skill Score (BSS), Expected
 * Calibration Error (ECE), exact Murphy decomposition (Reliability - Resolution
 * + Uncertainty = Brier), sharpness, and reliability bins.
 */
export function scoreForecastCalibration(
  records: readonly { readonly probability: number; readonly status: ForecastStatus }[],
  numBins = CALIBRATION_DEFAULT_BINS,
): ForecastCalibrationMetrics {
  const binCount = Number.isSafeInteger(numBins) && numBins >= 1 ? numBins : CALIBRATION_DEFAULT_BINS;
  const resolved = records.filter(
    (r) => r.status === "resolved_met" || r.status === "resolved_not_met",
  );
  const unresolved = records.filter((r) => r.status === "unresolved").length;
  const censored = records.filter((r) => r.status === "censored").length;
  const met = resolved.filter((r) => r.status === "resolved_met").length;
  const notMet = resolved.length - met;

  if (resolved.length === 0) {
    return {
      total: records.length,
      resolved: 0,
      unresolved,
      censored,
      met: 0,
      notMet: 0,
      brier: null,
      climatology: null,
      climatologyBrier: null,
      brierSkillScore: null,
      ece: null,
      reliability: null,
      resolution: null,
      uncertainty: null,
      sharpness: null,
      certainWrong: 0,
      bins: [],
    };
  }

  const n = resolved.length;
  let brierSum = 0;
  let probSum = 0;
  let certainWrong = 0;
  const buckets = Array.from({ length: binCount }, () => ({ count: 0, probSum: 0, outcomeSum: 0 }));
  const exactGroups = new Map<number, { count: number; outcomeSum: number }>();

  for (const record of resolved) {
    const p = record.probability;
    const y = record.status === "resolved_met" ? 1 : 0;
    brierSum += (p - y) ** 2;
    probSum += p;
    if ((p >= 0.99 && y === 0) || (p <= 0.01 && y === 1)) certainWrong += 1;

    const index = Math.min(binCount - 1, Math.max(0, Math.floor(p * binCount)));
    const bucket = buckets[index]!;
    bucket.count += 1;
    bucket.probSum += p;
    bucket.outcomeSum += y;

    const group = exactGroups.get(p);
    if (group === undefined) exactGroups.set(p, { count: 1, outcomeSum: y });
    else {
      group.count += 1;
      group.outcomeSum += y;
    }
  }

  const brier = brierSum / n;
  const climatology = met / n;
  const climatologyBrier = climatology * (1 - climatology);
  const brierSkillScore = climatologyBrier === 0 ? null : 1 - brier / climatologyBrier;
  const meanProb = probSum / n;
  const sharpness = resolved.reduce((acc, r) => acc + (r.probability - meanProb) ** 2, 0) / n;

  const bins: ReliabilityBin[] = [];
  let ece = 0;
  for (let i = 0; i < binCount; i += 1) {
    const bucket = buckets[i]!;
    if (bucket.count === 0) continue;
    const meanProbability = bucket.probSum / bucket.count;
    const observedRate = bucket.outcomeSum / bucket.count;
    const absGap = Math.abs(meanProbability - observedRate);
    ece += (bucket.count / n) * absGap;
    bins.push({
      binIndex: i,
      lower: i / binCount,
      upper: (i + 1) / binCount,
      count: bucket.count,
      meanProbability,
      observedRate,
      absGap,
    });
  }

  let reliability = 0;
  let resolution = 0;
  for (const [p, group] of exactGroups) {
    const weight = group.count / n;
    const obsRate = group.outcomeSum / group.count;
    reliability += weight * (p - obsRate) ** 2;
    resolution += weight * (obsRate - climatology) ** 2;
  }

  return {
    total: records.length,
    resolved: n,
    unresolved,
    censored,
    met,
    notMet,
    brier,
    climatology,
    climatologyBrier,
    brierSkillScore,
    ece,
    reliability,
    resolution,
    uncertainty: climatologyBrier,
    sharpness,
    certainWrong,
    bins,
  };
}
