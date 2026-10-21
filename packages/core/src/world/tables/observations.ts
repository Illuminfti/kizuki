import type { Database } from "bun:sqlite";
import type { WorldTableSpec } from "./registry";

/** Normalized children of one existing checked support admission. No capture,
 * interpretation, confidence or independent admission authority lives here. */
export function createObservationTables(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS world_observations (
  observation_id TEXT PRIMARY KEY,
  admission_id TEXT NOT NULL UNIQUE,
  support_key TEXT NOT NULL UNIQUE REFERENCES claim_v2_support(support_key) ON DELETE CASCADE,
  record TEXT NOT NULL CHECK(json_valid(record) AND json_extract(record,'$.schema')='kizuki.observation-record/v1'
    AND json_extract(record,'$.id')=observation_id AND json_extract(record,'$.admissionId')=admission_id)
) STRICT;
CREATE TABLE IF NOT EXISTS world_observation_events (
  observation_id TEXT NOT NULL REFERENCES world_observations(observation_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  PRIMARY KEY(observation_id,event_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS world_observation_immutable BEFORE UPDATE ON world_observations
BEGIN SELECT RAISE(ABORT,'observations are immutable admission children'); END;
CREATE TRIGGER IF NOT EXISTS world_observation_event_erased AFTER DELETE ON world_observation_events
BEGIN DELETE FROM world_observations WHERE observation_id=OLD.observation_id; END;
CREATE TRIGGER IF NOT EXISTS world_observation_history_erased AFTER DELETE ON claim_lifecycle_history
WHEN OLD.support_key IS NOT NULL
BEGIN DELETE FROM world_observations WHERE support_key=OLD.support_key; END;
CREATE TRIGGER IF NOT EXISTS world_observation_source_revoked AFTER UPDATE OF status ON source_grants
WHEN NEW.status<>'active'
BEGIN DELETE FROM world_observations WHERE observation_id IN (
  SELECT o.observation_id FROM world_observation_events o JOIN source_event_bindings b USING(event_id) WHERE b.source_key=NEW.source_key
); END;
`);
}

/** A coverage reset deliberately erases old admission positions, including
 * those of surviving support. Keep that support, but never invent a replacement
 * recorded time for its normalized child. Used by upgrade and legacy restore. */
export function removeObservationsWithoutHistory(db: Database): void {
  db.exec(`DELETE FROM world_observations WHERE NOT EXISTS (
    SELECT 1 FROM claim_lifecycle_history h WHERE h.support_key=world_observations.support_key
  )`);
}

export function applyObservationHistoryErasure(db: Database): void {
  createObservationTables(db);
  removeObservationsWithoutHistory(db);
}
export function observationTableSpecs(since: number): readonly WorldTableSpec[] {
  return [
    { name: "world_observations", class: "authority", since, columns: ["observation_id", "admission_id", "support_key", "record"], erasure: { via: "cascade", parent: "claim_v2_support" }, create: createObservationTables },
    { name: "world_observation_events", class: "authority", since, columns: ["observation_id", "event_id"], erasure: { via: "cascade", parent: "world_observations" }, create: createObservationTables },
  ];
}
