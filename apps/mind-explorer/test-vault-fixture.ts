import { Database } from "bun:sqlite";

export function seedSyntheticVaultDb(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  const now = new Date().toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      source_key TEXT,
      source_record_id TEXT,
      connector_id TEXT,
      kind TEXT,
      title TEXT,
      body TEXT,
      text TEXT,
      summary TEXT,
      metadata TEXT,
      occurred_at TEXT,
      observed_at TEXT,
      created_at TEXT,
      deleted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS connections (
      source_key TEXT PRIMARY KEY,
      connector_id TEXT,
      label TEXT,
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS claims (
      claim_id TEXT PRIMARY KEY,
      kind TEXT,
      subject TEXT,
      predicate TEXT,
      object TEXT,
      target TEXT,
      value TEXT,
      body TEXT,
      summary TEXT,
      status TEXT DEFAULT 'live',
      confidence REAL DEFAULT 0.9,
      is_world_typed INTEGER DEFAULT 1,
      source_key TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS claim_v2_semantics (
      claim_id TEXT PRIMARY KEY,
      subject_id TEXT,
      subject_label TEXT,
      entity_label TEXT,
      kind TEXT,
      predicate TEXT,
      object_text TEXT,
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS world_consolidation (
      handle_id TEXT PRIMARY KEY,
      kind TEXT,
      summary TEXT,
      basis_digest TEXT,
      status TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      created_at TEXT,
      completed_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS world_consolidation_basis (
      basis_digest TEXT,
      claim_id TEXT,
      source_key TEXT
    );
    CREATE TABLE IF NOT EXISTS identity_links (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      target_id TEXT
    );
    CREATE TABLE IF NOT EXISTS world_forecasts (
      id TEXT PRIMARY KEY,
      topic TEXT,
      status TEXT
    );
  `);

  db.query(
    `INSERT OR REPLACE INTO connections (source_key, connector_id, label, status) VALUES (?, ?, ?, ?)`,
  ).run("src-notes", "kizuki.notes", "Local Notes", "active");

  db.query(
    `INSERT OR REPLACE INTO events (id, event_id, source_key, source_record_id, connector_id, kind, title, body, text, summary, metadata, occurred_at, observed_at, created_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    "ev-atlas-1",
    "ev-atlas-1",
    "src-notes",
    "rec-atlas-1",
    "kizuki.notes",
    "note",
    "Atlas Roadmap Sync",
    "Atlas coordinates local indexing, verifiable search, and loopback APIs.",
    "Atlas coordinates local indexing, verifiable search, and loopback APIs.",
    "Atlas roadmap architecture summary.",
    JSON.stringify({ source: "notes" }),
    now,
    now,
    now,
  );

  db.query(
    `INSERT OR REPLACE INTO claims (claim_id, kind, subject, predicate, object, target, value, body, summary, status, confidence, is_world_typed, source_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 0.95, 1, ?, ?, ?)`,
  ).run(
    "cl-atlas-1",
    "concept",
    "Atlas",
    "coordinates",
    "local indexing",
    "Atlas",
    "Local-first knowledge workflow",
    "Atlas coordinates local indexing and loopback APIs.",
    "Atlas coordinates local indexing and loopback APIs.",
    "src-notes",
    now,
    now,
  );

  db.query(
    `INSERT OR REPLACE INTO claim_v2_semantics (claim_id, subject_id, subject_label, entity_label, kind, predicate, object_text, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "cl-atlas-1",
    "entity:atlas",
    "Atlas",
    "Atlas",
    "concept",
    "concept.label",
    "Atlas",
    JSON.stringify({ object: { value: "Atlas" } }),
  );

  db.query(
    `INSERT OR REPLACE INTO world_consolidation (handle_id, kind, summary, basis_digest, status, input_tokens, output_tokens, created_at, completed_at, updated_at)
     VALUES (?, ?, ?, ?, 'complete', 120, 64, ?, ?, ?)`,
  ).run(
    "project:atlas",
    "concept",
    "Atlas coordinates local indexing and loopback APIs.",
    "digest-atlas-1",
    now,
    now,
    now,
  );

  db.query(
    `INSERT OR REPLACE INTO world_consolidation_basis (basis_digest, claim_id, source_key) VALUES (?, ?, ?)`,
  ).run("digest-atlas-1", "cl-atlas-1", "src-notes");

  db.close();
}
