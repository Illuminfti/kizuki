import type { Database } from "bun:sqlite";
import { seedViewPartitions } from "../views/partitions";
import type { WorldTableSpec } from "./registry";
import { WORLD_MIGRATION_VERSIONS } from "./versions";

const HEX64 = (column: string) => `CHECK(length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*')`;
const since = WORLD_MIGRATION_VERSIONS.view;

const PARTITIONS = `
  CREATE TABLE IF NOT EXISTS world_view_partitions (
    partition_id INTEGER PRIMARY KEY CHECK(partition_id BETWEEN 0 AND 63),
    principal_id TEXT NOT NULL UNIQUE CHECK(length(principal_id) BETWEEN 1 AND 512),
    reserved_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS world_view_agent_revoked AFTER UPDATE OF revoked_at ON agents
    WHEN NEW.revoked_at IS NOT NULL
  BEGIN DELETE FROM world_view_partitions WHERE principal_id=NEW.agent_id; END;
  CREATE TRIGGER IF NOT EXISTS world_view_agent_deleted AFTER DELETE ON agents
  BEGIN DELETE FROM world_view_partitions WHERE principal_id=OLD.agent_id; END;`;

const TOKENS = `
  CREATE TABLE IF NOT EXISTS world_view_tokens (
    token_hash TEXT PRIMARY KEY ${HEX64("token_hash")},
    partition_id INTEGER NOT NULL REFERENCES world_view_partitions(partition_id) ON DELETE CASCADE,
    namespace_id TEXT NOT NULL REFERENCES world_authorization_namespaces(namespace_id) ON DELETE CASCADE,
    query_digest TEXT NOT NULL ${HEX64("query_digest")},
    projection BLOB NOT NULL CHECK(length(projection) BETWEEN 1 AND 262144),
    fingerprint TEXT NOT NULL ${HEX64("fingerprint")},
    bytes INTEGER NOT NULL CHECK(bytes=length(projection)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS world_view_tokens_partition ON world_view_tokens(partition_id, created_at, token_hash);`;

const DEPS = `
  CREATE TABLE IF NOT EXISTS world_view_token_deps (
    token_hash TEXT NOT NULL REFERENCES world_view_tokens(token_hash) ON DELETE CASCADE,
    namespace_id TEXT NOT NULL,
    wire_ref TEXT NOT NULL,
    FOREIGN KEY(namespace_id, wire_ref) REFERENCES world_wire_refs(namespace_id, wire_ref) ON DELETE CASCADE,
    PRIMARY KEY(token_hash, wire_ref)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS world_view_token_deps_ref ON world_view_token_deps(namespace_id, wire_ref);
  CREATE TRIGGER IF NOT EXISTS world_view_token_dep_erased AFTER DELETE ON world_view_token_deps
  BEGIN DELETE FROM world_view_tokens WHERE token_hash=OLD.token_hash; END;`;

const HANDLES = `
  CREATE TABLE IF NOT EXISTS world_resume_handles (
    handle_hash TEXT PRIMARY KEY ${HEX64("handle_hash")},
    partition_id INTEGER NOT NULL REFERENCES world_view_partitions(partition_id) ON DELETE CASCADE,
    handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64),
    valid TEXT NOT NULL CHECK(length(valid)<=1024),
    scope TEXT NOT NULL CHECK(length(scope)<=32768),
    scope_digest TEXT NOT NULL ${HEX64("scope_digest")},
    recorded_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS world_resume_handles_partition ON world_resume_handles(partition_id, created_at, handle_hash);`;

const partitions: WorldTableSpec = {
  name: "world_view_partitions",
  class: "cache",
  since,
  columns: ["partition_id", "principal_id", "reserved_at"],
  erasure: { via: "none", reason: "holds principal ids only; a revoked or deleted agent ends its row by trigger" },
  create: (db) => db.exec(PARTITIONS),
  reset: (db) => {
    db.exec(PARTITIONS);
    db.exec("DELETE FROM world_view_partitions");
    seedViewPartitions(db);
  },
};

const tokens: WorldTableSpec = {
  name: "world_view_tokens",
  class: "cache",
  since,
  columns: [
    "token_hash",
    "partition_id",
    "namespace_id",
    "query_digest",
    "projection",
    "fingerprint",
    "bytes",
    "created_at",
    "expires_at",
  ],
  erasure: { via: "trigger", triggers: ["world_view_token_dep_erased"] },
  create: (db) => db.exec(TOKENS),
};

const deps: WorldTableSpec = {
  name: "world_view_token_deps",
  class: "cache",
  since,
  columns: ["token_hash", "namespace_id", "wire_ref"],
  erasure: { via: "cascade", parent: "world_wire_refs" },
  create: (db) => db.exec(DEPS),
};

const handles: WorldTableSpec = {
  name: "world_resume_handles",
  class: "cache",
  since,
  columns: ["handle_hash", "partition_id", "handle_id", "operation", "valid", "scope", "scope_digest", "recorded_at", "created_at", "expires_at"],
  erasure: { via: "cascade", parent: "semantic_handles" },
  create: (db) => db.exec(HANDLES),
};

/** Parents before children, the order the registry needs. */
export const WORLD_VIEW_TABLE_SPECS: readonly WorldTableSpec[] = [partitions, tokens, deps, handles];

/** The migration: the tables, then the reservations a vault starts with. */
export function applyWorldViewTables(db: Database): void {
  for (const spec of WORLD_VIEW_TABLE_SPECS) spec.create?.(db);
  seedViewPartitions(db);
}
