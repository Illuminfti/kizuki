import type { Database } from "bun:sqlite";
import type { WorldTableSpec } from "./registry";
import { WORLD_MIGRATION_VERSIONS } from "./versions";

/** Dispositions and delivery receipts contain no factual content or authority. */
export function applyAttention(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS world_attention_state (
  namespace_id TEXT NOT NULL REFERENCES world_authorization_namespaces(namespace_id) ON DELETE CASCADE,
  cue_key TEXT NOT NULL CHECK(length(cue_key)=43),
  handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('blocker','uncertainty','commitment_due','stale_summary')),
  disposition TEXT NOT NULL CHECK(disposition IN ('none','dismissed','snoozed')),
  snoozed_until TEXT,
  delivered_at TEXT,
  event_ids TEXT NOT NULL CHECK(json_valid(event_ids) AND json_type(event_ids)='array'),
  claim_ids TEXT NOT NULL CHECK(json_valid(claim_ids) AND json_type(claim_ids)='array'),
  source_keys TEXT NOT NULL CHECK(json_valid(source_keys) AND json_type(source_keys)='array'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(namespace_id,cue_key),
  CHECK((disposition='snoozed' AND snoozed_until IS NOT NULL) OR (disposition<>'snoozed' AND snoozed_until IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS world_attention_handle ON world_attention_state(handle_id);
CREATE TRIGGER IF NOT EXISTS world_attention_event_erased BEFORE DELETE ON events
BEGIN DELETE FROM world_attention_state WHERE EXISTS(SELECT 1 FROM json_each(event_ids) WHERE value=OLD.event_id); END;
CREATE TRIGGER IF NOT EXISTS world_attention_claim_erased BEFORE DELETE ON claims
BEGIN DELETE FROM world_attention_state WHERE EXISTS(SELECT 1 FROM json_each(claim_ids) WHERE value=OLD.claim_id); END;
CREATE TRIGGER IF NOT EXISTS world_attention_claim_changed AFTER UPDATE OF status,valid_to ON claims
WHEN NEW.status<>OLD.status OR NEW.valid_to IS NOT OLD.valid_to
BEGIN DELETE FROM world_attention_state WHERE EXISTS(SELECT 1 FROM json_each(claim_ids) WHERE value=OLD.claim_id); END;
CREATE TRIGGER IF NOT EXISTS world_attention_grant_changed AFTER UPDATE ON source_grants
BEGIN DELETE FROM world_attention_state WHERE EXISTS(SELECT 1 FROM json_each(source_keys) WHERE value=OLD.source_key); END;
CREATE TRIGGER IF NOT EXISTS world_attention_grant_erased BEFORE DELETE ON source_grants
BEGIN DELETE FROM world_attention_state WHERE EXISTS(SELECT 1 FROM json_each(source_keys) WHERE value=OLD.source_key); END;
`);
}
export const ATTENTION_TABLE_SPECS: readonly WorldTableSpec[] = [{
  name: "world_attention_state", class: "bookkeeping", since: WORLD_MIGRATION_VERSIONS.attn,
  columns: ["namespace_id", "cue_key", "handle_id", "source", "disposition", "snoozed_until", "delivered_at", "event_ids", "claim_ids", "source_keys", "updated_at"],
  erasure: { via: "trigger", triggers: ["world_attention_event_erased", "world_attention_claim_erased", "world_attention_claim_changed", "world_attention_grant_changed", "world_attention_grant_erased"] },
  create: applyAttention,
}];
