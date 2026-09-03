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
  relay_owner_corrections INTEGER NOT NULL DEFAULT 1,
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

/** RFC 0002 §6.4 widened the grant; existing rows keep the relay they had. */
function addRelayColumn(db: Database): void {
  const present = db
    .query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('agent_grants')",
    )
    .all()
    .some(({ name }) => name === "relay_owner_corrections");
  if (present) return;
  db.exec(
    `ALTER TABLE agent_grants
       ADD COLUMN relay_owner_corrections INTEGER NOT NULL DEFAULT 1`,
  );
}

export function initAgents(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  addRelayColumn(db);
}
