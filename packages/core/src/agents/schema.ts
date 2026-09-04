import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import { AGENT_SCHEMA_VERSION } from "./types";

export { AGENT_SCHEMA_VERSION };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE CHECK (
    length(name) BETWEEN 2 AND 64
    AND name GLOB '[a-z0-9][a-z0-9-]*'
  ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  quarantined_at TEXT,
  quarantine_reason TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS agent_grants (
  agent_id   TEXT PRIMARY KEY REFERENCES agents(agent_id),
  ceiling    TEXT NOT NULL CHECK (ceiling IN ('public', 'personal', 'private')),
  types      TEXT,
  subjects   TEXT,
  since      TEXT,
  until      TEXT,
  tools      TEXT NOT NULL,
  rate_limit_per_minute INTEGER NOT NULL CHECK (
    rate_limit_per_minute >= 1 AND rate_limit_per_minute <= 1000
  ),
  relay_owner_corrections INTEGER NOT NULL DEFAULT 0 CHECK (
    relay_owner_corrections IN (0, 1)
  ),
  grant_epoch INTEGER NOT NULL DEFAULT 1 CHECK (grant_epoch >= 1),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agent_audit (
  audit_id     TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  query_shape  TEXT NOT NULL,
  served       TEXT NOT NULL,
  denied       TEXT NOT NULL,
  served_count INTEGER NOT NULL DEFAULT 0 CHECK (served_count >= 0),
  denied_count INTEGER NOT NULL DEFAULT 0 CHECK (denied_count >= 0),
  grant_epoch  INTEGER,
  at           TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS agent_audit_by_agent
  ON agent_audit(agent_id, at, audit_id);
`;

function columnNames(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
      .all()
      .map(({ name }) => name),
  );
}

function addColumn(db: Database, table: string, column: string, ddl: string): void {
  if (columnNames(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/**
 * Bring a standalone or pre-v9 agent schema forward without inventing a
 * second owner. Missing columns default closed: no relay, epoch 1.
 */
function migrateExisting(db: Database): void {
  if (!tableExists(db, "agents")) return;
  addColumn(db, "agents", "quarantined_at", "quarantined_at TEXT");
  addColumn(db, "agents", "quarantine_reason", "quarantine_reason TEXT");
  if (!tableExists(db, "agent_grants")) return;
  addColumn(
    db,
    "agent_grants",
    "relay_owner_corrections",
    "relay_owner_corrections INTEGER NOT NULL DEFAULT 0",
  );
  addColumn(
    db,
    "agent_grants",
    "grant_epoch",
    "grant_epoch INTEGER NOT NULL DEFAULT 1",
  );
  if (!tableExists(db, "agent_audit")) return;
  addColumn(
    db,
    "agent_audit",
    "served_count",
    "served_count INTEGER NOT NULL DEFAULT 0",
  );
  addColumn(
    db,
    "agent_audit",
    "denied_count",
    "denied_count INTEGER NOT NULL DEFAULT 0",
  );
  addColumn(db, "agent_audit", "grant_epoch", "grant_epoch INTEGER");
}

export function applyAgentsV9(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON");
  migrateExisting(db);
  db.exec("DROP INDEX IF EXISTS agent_audit_by_agent");
  db.exec(SCHEMA);
}

export function initAgents(db: Database): void {
  applyAgentsV9(db);
}
