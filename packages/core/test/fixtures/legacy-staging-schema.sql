
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  target      TEXT,
  body        TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  provenance  TEXT NOT NULL,
  subjects    TEXT NOT NULL,
  producer    TEXT NOT NULL,
  confidence  REAL NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  body_hash   TEXT NOT NULL
) STRICT;

-- Purge reviews need a fresh proposal when different purged provenance reaches
-- the same unchanged page body. Their pending duplicates are resolved in the
-- filing transaction; every other kind keeps the durable database constraint.
DROP INDEX IF EXISTS proposals_idempotency;
CREATE UNIQUE INDEX proposals_idempotency
  ON proposals (kind, coalesce(target, ''), body_hash)
  WHERE kind <> 'purge_review';

CREATE INDEX IF NOT EXISTS proposals_by_status
  ON proposals (status, created_at);

CREATE TABLE IF NOT EXISTS rejections (
  body_hash   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (body_hash, proposal_id)
) STRICT;

CREATE TABLE IF NOT EXISTS promotions (
  receipt_id  TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  provenance  TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  page_path   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'claim',
  before_hash TEXT,
  after_hash  TEXT NOT NULL,
  at          TEXT NOT NULL
) STRICT;
