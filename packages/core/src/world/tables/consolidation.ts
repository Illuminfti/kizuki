import type { Database } from "bun:sqlite";
import type { WorldTableSpec } from "./registry";
import { WORLD_MIGRATION_VERSIONS } from "./versions";

const DDL = `
CREATE TABLE IF NOT EXISTS world_consolidation (
  basis_digest TEXT PRIMARY KEY,
  handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  members TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','complete')),
  summary TEXT CHECK(summary IS NULL OR length(summary)<=1200),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  model_ref_hash TEXT,
  response_hash TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS world_consolidation_handle ON world_consolidation(handle_id,kind,basis_digest);
CREATE INDEX IF NOT EXISTS world_consolidation_expiry ON world_consolidation(expires_at);
CREATE TABLE IF NOT EXISTS world_consolidation_basis (
  basis_digest TEXT NOT NULL REFERENCES world_consolidation(basis_digest) ON DELETE CASCADE,
  support_key TEXT NOT NULL REFERENCES claim_v2_support(support_key) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  PRIMARY KEY(basis_digest,support_key)
) STRICT;
CREATE INDEX IF NOT EXISTS world_consolidation_support ON world_consolidation_basis(support_key,basis_digest);
CREATE INDEX IF NOT EXISTS world_consolidation_source ON world_consolidation_basis(source_key,basis_digest);
CREATE TABLE IF NOT EXISTS world_consolidation_jobs (
  job_key TEXT PRIMARY KEY,
  basis_digest TEXT UNIQUE REFERENCES world_consolidation(basis_digest) ON DELETE CASCADE,
  nonce TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  outcome TEXT,
  cursor TEXT,
  updated_at TEXT NOT NULL,
  CHECK((job_key='cursor' AND basis_digest IS NULL) OR (job_key<>'cursor' AND basis_digest IS NOT NULL))
) STRICT;
CREATE TRIGGER IF NOT EXISTS world_consolidation_support_erased BEFORE DELETE ON claim_v2_support
BEGIN DELETE FROM world_consolidation WHERE basis_digest IN (SELECT basis_digest FROM world_consolidation_basis WHERE support_key=OLD.support_key); END;
CREATE TRIGGER IF NOT EXISTS world_consolidation_grant_changed AFTER UPDATE ON source_grants
BEGIN DELETE FROM world_consolidation WHERE basis_digest IN (SELECT basis_digest FROM world_consolidation_basis WHERE source_key=OLD.source_key); END;
CREATE TRIGGER IF NOT EXISTS world_consolidation_grant_erased BEFORE DELETE ON source_grants
BEGIN DELETE FROM world_consolidation WHERE basis_digest IN (SELECT basis_digest FROM world_consolidation_basis WHERE source_key=OLD.source_key); END;
CREATE TRIGGER IF NOT EXISTS world_consolidation_claim_changed AFTER UPDATE OF status,valid_to ON claims
WHEN NEW.status<>OLD.status OR NEW.valid_to IS NOT OLD.valid_to
BEGIN DELETE FROM world_consolidation WHERE basis_digest IN (SELECT basis_digest FROM world_consolidation_basis WHERE claim_id=OLD.claim_id); END;
`;
export function applyConsolidation(db: Database): void { db.exec(DDL); }
export const CONSOLIDATION_TABLE_SPECS: readonly WorldTableSpec[] = [
  { name: "world_consolidation", class: "derived", since: WORLD_MIGRATION_VERSIONS.consol,
    columns: ["basis_digest","handle_id","kind","members","status","summary","created_at","expires_at","completed_at","model_ref_hash","response_hash","input_tokens","output_tokens"],
    erasure: { via: "trigger", triggers: ["world_consolidation_support_erased","world_consolidation_grant_changed","world_consolidation_grant_erased","world_consolidation_claim_changed"] }, create: applyConsolidation },
  { name: "world_consolidation_basis", class: "derived", since: WORLD_MIGRATION_VERSIONS.consol,
    columns: ["basis_digest","support_key","claim_id","source_key"], erasure: { via: "cascade", parent: "world_consolidation" } },
  { name: "world_consolidation_jobs", class: "derived", since: WORLD_MIGRATION_VERSIONS.consol,
    columns: ["job_key","basis_digest","nonce","attempts","next_at","outcome","cursor","updated_at"], erasure: { via: "cascade", parent: "world_consolidation" } },
];
