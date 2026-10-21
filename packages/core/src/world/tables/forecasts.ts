import type { Database } from "bun:sqlite";
import type { WorldTableSpec } from "./registry";
import { WORLD_MIGRATION_VERSIONS } from "./versions";

/** Frozen authority journal. It never feeds claims, canon, retrieval or confidence. */
export function applyForecasts(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS world_forecasts (
  forecast_id TEXT PRIMARY KEY,
  handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id) ON DELETE CASCADE,
  question TEXT NOT NULL CHECK(question IN ('commitment_met_by_due','next_independent_inspection_meets_criterion')),
  record_class TEXT NOT NULL CHECK(record_class IN ('prediction','analysis')),
  frozen_at TEXT NOT NULL,
  frozen_sequence INTEGER NOT NULL CHECK(frozen_sequence>=0),
  rule_version TEXT NOT NULL CHECK(rule_version='dependency-v1'),
  probability REAL NOT NULL CHECK(probability>=0 AND probability<=1),
  due_at TEXT,
  conditions TEXT CHECK(conditions IS NULL OR (json_valid(conditions) AND length(conditions)<=4096)),
  basis_key TEXT NOT NULL CHECK(length(basis_key)=64),
  basis_digest TEXT NOT NULL CHECK(length(basis_digest)=64),
  UNIQUE(handle_id,question,record_class,basis_key)
) STRICT;
CREATE INDEX IF NOT EXISTS world_forecasts_subject ON world_forecasts(handle_id,frozen_at,forecast_id);
CREATE TABLE IF NOT EXISTS world_forecast_inputs (
  forecast_id TEXT NOT NULL REFERENCES world_forecasts(forecast_id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  proof TEXT NOT NULL CHECK(json_valid(proof) AND length(proof)<=65536),
  PRIMARY KEY(forecast_id,claim_id)
) STRICT;
CREATE INDEX IF NOT EXISTS world_forecast_input_claim ON world_forecast_inputs(claim_id,forecast_id);
CREATE TABLE IF NOT EXISTS world_forecast_resolutions (
  forecast_id TEXT PRIMARY KEY REFERENCES world_forecasts(forecast_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('resolved_met','resolved_not_met','censored','invalidated')),
  resolved_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  proof TEXT NOT NULL CHECK(json_valid(proof) AND json_type(proof)='array' AND length(proof)<=262144),
  CHECK((status='invalidated' AND proof='[]') OR (status<>'invalidated' AND json_array_length(proof)>0))
) STRICT;
CREATE TRIGGER IF NOT EXISTS world_forecast_history_reset AFTER UPDATE ON claim_history_coverage
WHEN NEW.complete_from_sequence>OLD.complete_from_sequence
BEGIN DELETE FROM world_forecasts WHERE forecast_id IN (SELECT forecast_id FROM world_forecast_inputs WHERE claim_id=OLD.claim_id); END;
CREATE TRIGGER IF NOT EXISTS world_forecast_cursor_erased BEFORE DELETE ON world_forecasts
BEGIN DELETE FROM rail_cursors WHERE rail='forecast' AND source_key='resolution' AND json_extract(cursor,'$')=OLD.forecast_id; END;
CREATE TRIGGER IF NOT EXISTS world_forecast_handle_cursor_erased BEFORE DELETE ON semantic_handles
BEGIN DELETE FROM rail_cursors WHERE rail='forecast' AND source_key='discovery' AND json_extract(cursor,'$')=OLD.handle_id; END;
CREATE TRIGGER IF NOT EXISTS world_forecast_immutable BEFORE UPDATE ON world_forecasts BEGIN SELECT RAISE(ABORT,'forecast journal is append only'); END;
CREATE TRIGGER IF NOT EXISTS world_forecast_inputs_immutable BEFORE UPDATE ON world_forecast_inputs BEGIN SELECT RAISE(ABORT,'forecast inputs are append only'); END;
CREATE TRIGGER IF NOT EXISTS world_forecast_resolution_immutable BEFORE UPDATE ON world_forecast_resolutions
WHEN NOT (OLD.status<>'invalidated' AND NEW.status='invalidated' AND NEW.forecast_id=OLD.forecast_id AND NEW.proof='[]'
  AND NEW.resolved_at=(SELECT frozen_at FROM world_forecasts WHERE forecast_id=OLD.forecast_id) AND NEW.recorded_at=NEW.resolved_at)
BEGIN SELECT RAISE(ABORT,'forecast resolution is append only'); END;
`);
  // Input loss removes the prediction. Resolution-only loss erases its private
  // evidence and times while retaining a terminal marker: later observations
  // cannot replace the first resolution, and other principals keep seeing the
  // same input-backed unresolved prediction.
  const erase = (condition: string) => `DELETE FROM world_forecasts WHERE forecast_id IN (
    SELECT forecast_id FROM world_forecast_inputs i WHERE ${condition.replaceAll("DEPS", "i.proof")});
    UPDATE world_forecast_resolutions SET status='invalidated',proof='[]',
      resolved_at=(SELECT frozen_at FROM world_forecasts f WHERE f.forecast_id=world_forecast_resolutions.forecast_id),
      recorded_at=(SELECT frozen_at FROM world_forecasts f WHERE f.forecast_id=world_forecast_resolutions.forecast_id)
    WHERE status<>'invalidated' AND forecast_id IN (
      SELECT r.forecast_id FROM world_forecast_resolutions r,json_each(r.proof) pin WHERE ${condition.replaceAll("DEPS", "pin.value")});`;
  for (const [name, timing, table, condition, when] of [
    ["event_erased","BEFORE DELETE","events","EXISTS(SELECT 1 FROM json_each(json_extract(DEPS,'$.events')) WHERE value=OLD.event_id)",""],
    ["support_erased","BEFORE DELETE","claim_v2_support","EXISTS(SELECT 1 FROM json_each(json_extract(DEPS,'$.supports')) WHERE value=OLD.support_key)",""],
    ["claim_erased","BEFORE DELETE","claims","json_extract(DEPS,'$.claim')=OLD.claim_id",""],
    ["claim_changed","AFTER UPDATE OF status,valid_to","claims","json_extract(DEPS,'$.claim')=OLD.claim_id","WHEN NEW.status<>OLD.status OR NEW.valid_to IS NOT OLD.valid_to"],
    ["grant_changed","AFTER UPDATE","source_grants","EXISTS(SELECT 1 FROM json_each(json_extract(DEPS,'$.sources')) WHERE value=OLD.source_key)",""],
    ["grant_erased","BEFORE DELETE","source_grants","EXISTS(SELECT 1 FROM json_each(json_extract(DEPS,'$.sources')) WHERE value=OLD.source_key)",""],
    ["receipt_erased","BEFORE DELETE","canon_receipts","json_extract(DEPS,'$.receipt')=OLD.receipt_id",""],
  ] as const) db.exec(`CREATE TRIGGER IF NOT EXISTS world_forecast_${name} ${timing} ON ${table} ${when} BEGIN ${erase(condition)} END;`);
}
export const FORECAST_TABLE_SPECS: readonly WorldTableSpec[] = [
  { name: "world_forecasts", class: "authority", since: WORLD_MIGRATION_VERSIONS.fcst,
    columns: ["forecast_id","handle_id","question","record_class","frozen_at","frozen_sequence","rule_version","probability","due_at","conditions","basis_key","basis_digest"],
    erasure: { via: "trigger", triggers: ["world_forecast_history_reset","world_forecast_event_erased","world_forecast_support_erased","world_forecast_claim_erased","world_forecast_claim_changed","world_forecast_grant_changed","world_forecast_grant_erased","world_forecast_receipt_erased"] }, create: applyForecasts },
  { name: "world_forecast_inputs", class: "authority", since: WORLD_MIGRATION_VERSIONS.fcst, columns: ["forecast_id","claim_id","proof"], erasure: { via: "cascade", parent: "world_forecasts" } },
  { name: "world_forecast_resolutions", class: "authority", since: WORLD_MIGRATION_VERSIONS.fcst, columns: ["forecast_id","status","resolved_at","recorded_at","proof"], erasure: { via: "cascade", parent: "world_forecasts" } },
];
