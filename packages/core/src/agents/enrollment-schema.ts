import type { Database } from "bun:sqlite";

/** Local-only enrollment custody.  Portable backup deliberately omits it. */
export function applyAgentEnrollmentV17(db: Database): void {
  db.exec(`
    CREATE TABLE agent_enrollments (
      operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 8 AND 64 AND substr(operation_id,1,1) GLOB '[A-Za-z0-9]' AND operation_id NOT GLOB '*[^A-Za-z0-9_-]*'),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      destination_digest TEXT NOT NULL CHECK (length(destination_digest) = 64 AND destination_digest NOT GLOB '*[^0-9a-f]*'),
      agent_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 64 AND substr(name,1,1) GLOB '[a-z0-9]' AND name NOT GLOB '*[^a-z0-9-]*'),
      grant_json TEXT NOT NULL CHECK (length(grant_json) <= 32768),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'file_bound', 'completed', 'cancelled')),
      parent_dev TEXT NOT NULL CHECK (length(parent_dev) > 0 AND parent_dev NOT GLOB '*[^0-9]*'),
      parent_ino TEXT NOT NULL CHECK (length(parent_ino) > 0 AND parent_ino NOT GLOB '*[^0-9]*'),
      generation TEXT,
      token_hash TEXT,
      credential_digest TEXT,
      credential_size INTEGER,
      file_dev TEXT CHECK (file_dev IS NULL OR (length(file_dev) > 0 AND file_dev NOT GLOB '*[^0-9]*')),
      file_ino TEXT CHECK (file_ino IS NULL OR (length(file_ino) > 0 AND file_ino NOT GLOB '*[^0-9]*')),
      created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
      updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
      completed_at TEXT CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.???Z'),
      cancelled_at TEXT CHECK (cancelled_at IS NULL OR cancelled_at GLOB '????-??-??T??:??:??.???Z'),
      CHECK (
        (state = 'reserved' AND generation IS NULL AND token_hash IS NULL AND credential_digest IS NULL
          AND credential_size IS NULL AND file_dev IS NULL AND file_ino IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
        OR
        (state = 'file_bound' AND generation IS NOT NULL AND length(generation) = 32 AND generation NOT GLOB '*[^0-9a-f]*'
          AND token_hash IS NOT NULL AND length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
          AND credential_digest IS NOT NULL AND length(credential_digest) = 64 AND credential_digest NOT GLOB '*[^0-9a-f]*'
          AND credential_size IS NOT NULL AND credential_size BETWEEN 1 AND 1024 AND file_dev IS NOT NULL AND file_ino IS NOT NULL
          AND completed_at IS NULL AND cancelled_at IS NULL)
        OR
        (state = 'completed' AND generation IS NOT NULL AND length(generation) = 32 AND generation NOT GLOB '*[^0-9a-f]*'
          AND token_hash IS NOT NULL AND length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
          AND credential_digest IS NOT NULL AND length(credential_digest) = 64 AND credential_digest NOT GLOB '*[^0-9a-f]*'
          AND credential_size IS NOT NULL AND credential_size BETWEEN 1 AND 1024 AND file_dev IS NOT NULL AND file_ino IS NOT NULL
          AND completed_at IS NOT NULL AND cancelled_at IS NULL)
        OR
        (state = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL AND
          ((generation IS NULL AND token_hash IS NULL AND credential_digest IS NULL AND credential_size IS NULL AND file_dev IS NULL AND file_ino IS NULL)
           OR (generation IS NOT NULL AND length(generation) = 32 AND generation NOT GLOB '*[^0-9a-f]*'
             AND token_hash IS NOT NULL AND length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
             AND credential_digest IS NOT NULL AND length(credential_digest) = 64 AND credential_digest NOT GLOB '*[^0-9a-f]*'
             AND credential_size IS NOT NULL AND credential_size BETWEEN 1 AND 1024 AND file_dev IS NOT NULL AND file_ino IS NOT NULL)))
      )
    ) STRICT;
    CREATE UNIQUE INDEX agent_enrollments_live_name
      ON agent_enrollments(name) WHERE state != 'cancelled';
    CREATE UNIQUE INDEX agent_enrollments_live_destination
      ON agent_enrollments(destination_digest) WHERE state != 'cancelled';
    CREATE UNIQUE INDEX agent_enrollments_pending_token
      ON agent_enrollments(token_hash) WHERE token_hash IS NOT NULL AND state != 'cancelled';
    CREATE TRIGGER agent_enrollments_block_legacy_agent_insert
    BEFORE INSERT ON agents
    WHEN EXISTS (
      SELECT 1 FROM agent_enrollments
       WHERE state != 'cancelled'
         AND (name = NEW.name OR agent_id = NEW.agent_id OR token_hash = NEW.token_hash)
         AND NOT (state = 'file_bound' AND name = NEW.name AND agent_id = NEW.agent_id AND token_hash = NEW.token_hash)
    )
    BEGIN
      SELECT RAISE(ABORT, 'agent enrollment reservation conflicts with agent insert');
    END;
  `);
}
