import type { Database } from "bun:sqlite";

/**
 * RFC 0002 §18.1 lists `connector_sensitivity` under v6 with ports and
 * identity. This lane ships the table as the next sequential schema version
 * so later daemon/ports/identity migrations can follow without skipping a
 * version or colliding on those tables.
 */
export const SENSITIVITY_SCHEMA_VERSION = 5;

const TABLE = `
CREATE TABLE IF NOT EXISTS connector_sensitivity (
  connector_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  default_sensitivity TEXT NOT NULL CHECK (
    default_sensitivity IN ('public', 'personal', 'private')
  ),
  floor TEXT NOT NULL CHECK (floor IN ('public', 'personal', 'private')),
  set_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (connector_id, source_key)
) STRICT;
`;

export function initSensitivity(db: Database): void {
  db.exec(TABLE);
}

export function applySensitivityV5(db: Database): void {
  initSensitivity(db);
}
