import type { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS agent_grants (
  agent_id   TEXT PRIMARY KEY REFERENCES agents(agent_id),
  ceiling    TEXT NOT NULL,
  types      TEXT,
  subjects   TEXT,
  since      TEXT,
  until      TEXT,
  tools      TEXT NOT NULL,
  rate_limit_per_minute INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agent_audit (
  audit_id     TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  query_shape  TEXT NOT NULL,
  served       TEXT NOT NULL,
  denied       TEXT NOT NULL,
  at           TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS agent_audit_by_agent
  ON agent_audit(agent_id, at);
`;

export function initAgents(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
}
