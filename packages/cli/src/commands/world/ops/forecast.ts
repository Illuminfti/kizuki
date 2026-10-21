import { isWorldWireToken, type Forecast, type ForecastScores } from "@kizuki/core/world";
import { coverageLine, temporalInput } from "./shared";
import type { WorldCliOp } from "./types";
const limitation="Fixed dependency-v1 heuristic: 0.25 if a supported prerequisite is due later; otherwise 0.5. Uncalibrated, no model, no execution authority. The 20-resolution reporting gate does not establish statistical sufficiency.";
export const forecastCli:WorldCliOp<Forecast>={
  usage:"--ref TOKEN [--known-at TIME]",options:["--ref","--known-at"],bounds:{"--ref":"opaque commitment object token","--known-at":"RFC3339 journal cutoff"},
  buildInput:options=>{const token=options.get("--ref"),when=temporalInput(options);return token===undefined||!isWorldWireToken(token)||when===null?null:{commitment:{kind:"object",token},...when};},
  render:data=>[limitation,...data.records.map(row=>`${row.class} ${row.question}: heuristic ${row.probability}; ${row.status}; frozen ${row.frozenAt}`),coverageLine(data.coverage)],
};
export const forecastScoresCli:WorldCliOp<ForecastScores>={
  usage:"[--known-at TIME]",options:["--known-at"],bounds:{"--known-at":"RFC3339 journal cutoff"},buildInput:options=>temporalInput(options),
  render:data=>[limitation,`Resolved ${data.resolved}; unresolved ${data.unresolved}; censored ${data.censored}; Brier ${typeof data.brier==="number"?data.brier:"unavailable"}.`,"Predictive score does not establish usefulness; no independent decision-utility evidence is available.",coverageLine(data.coverage)],
};
