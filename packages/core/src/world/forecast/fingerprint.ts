import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../util/hash";
import type { ForecastRow, ResolutionRow } from "./store";

/** Leaf publication check: importing dependency guards must not initialize readers. */
export function forecastFingerprint(db:Database,id:string,includeResolution=true):string|null {
  const row=db.query<ForecastRow,[string]>("SELECT * FROM world_forecasts WHERE forecast_id=?").get(id);
  if(row===null)return null;
  const resolution=includeResolution?db.query<ResolutionRow,[string]>("SELECT status,resolved_at,recorded_at,recorded_sequence,proof FROM world_forecast_resolutions WHERE forecast_id=?").get(id):null;
  return sha256Hex(canonicalJson([row,resolution]));
}
