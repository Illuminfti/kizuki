import { constants, Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Sensitivity lattice for MemT procedural memory and snapshot partitions.
 * Strictly extends Kizuki's core lattice (`public < personal < private`) by
 * inserting `work` between `public` and `personal`.
 */
export const MEMT_SENSITIVITY_ORDER = {
  public: 0,
  work: 1,
  personal: 2,
  private: 3,
} as const;

export type MemtSensitivity = keyof typeof MEMT_SENSITIVITY_ORDER;

export const MEMT_SENSITIVITIES = [
  "public",
  "work",
  "personal",
  "private",
] as const;

export function isMemtSensitivity(value: unknown): value is MemtSensitivity {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(MEMT_SENSITIVITY_ORDER, value)
  );
}

export function compareSensitivity(
  left: MemtSensitivity,
  right: MemtSensitivity,
): number {
  return MEMT_SENSITIVITY_ORDER[left] - MEMT_SENSITIVITY_ORDER[right];
}

export function maxSensitivity(
  left: MemtSensitivity,
  right: MemtSensitivity,
): MemtSensitivity {
  return MEMT_SENSITIVITY_ORDER[left] >= MEMT_SENSITIVITY_ORDER[right]
    ? left
    : right;
}

export function withinSensitivityCeiling(
  item: MemtSensitivity,
  ceiling: MemtSensitivity,
): boolean {
  return MEMT_SENSITIVITY_ORDER[item] <= MEMT_SENSITIVITY_ORDER[ceiling];
}

export function allowedSensitivitiesForCeiling(
  ceiling: MemtSensitivity,
): MemtSensitivity[] {
  const maxRank = MEMT_SENSITIVITY_ORDER[ceiling];
  return MEMT_SENSITIVITIES.filter(
    (level) => MEMT_SENSITIVITY_ORDER[level] <= maxRank,
  );
}

export function defaultMemtRegistryPath(vaultPath: string): string {
  return join(vaultPath, ".kizuki", "memt", "registry.sqlite");
}

export function defaultMemtSnapshotDir(vaultPath: string): string {
  return join(vaultPath, ".kizuki", "memt", "snapshots");
}

export function canonicalSourceRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("event:")) {
    const raw = trimmed.slice("event:".length);
    if (raw.length > 0) return raw;
  }
  return trimmed;
}

export function normalizeSourceRefVariants(ref: string): string[] {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return [];
  const variants = new Set<string>([trimmed]);
  if (trimmed.startsWith("event:")) {
    const raw = trimmed.slice("event:".length);
    if (raw.length > 0) variants.add(raw);
  } else if (!trimmed.includes(":")) {
    variants.add(`event:${trimmed}`);
  }
  return [...variants];
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sha256Hex(input: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

const REGISTRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memt_snapshots (
  partition_key TEXT PRIMARY KEY,
  sensitivity_ceiling TEXT NOT NULL CHECK (
    sensitivity_ceiling IN ('public', 'work', 'personal', 'private')
  ),
  source_ids_json TEXT NOT NULL,
  snapshot_name TEXT NOT NULL,
  identity_sha256 TEXT NOT NULL,
  event_watermark TEXT NOT NULL,
  taint_state TEXT NOT NULL CHECK (
    taint_state IN ('clean', 'stale', 'purged_invalidated')
  ),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memt_snapshots_name
  ON memt_snapshots(snapshot_name);

CREATE INDEX IF NOT EXISTS idx_memt_snapshots_taint
  ON memt_snapshots(taint_state);

CREATE TABLE IF NOT EXISTS memt_snapshot_sources (
  partition_key TEXT NOT NULL REFERENCES memt_snapshots(partition_key) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  PRIMARY KEY (partition_key, source_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memt_snapshot_sources_source
  ON memt_snapshot_sources(source_id);

CREATE TABLE IF NOT EXISTS experiences (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (
    sensitivity IN ('public', 'work', 'personal', 'private')
  ),
  condition TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  verification TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('verified', 'observed', 'failed', 'superseded')
  ),
  citations_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  internalized_in_snapshot TEXT,
  embedding BLOB,
  dedup_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_experiences_domain_scope
  ON experiences(domain, scope_key);

CREATE INDEX IF NOT EXISTS idx_experiences_dedup
  ON experiences(dedup_key);

CREATE INDEX IF NOT EXISTS idx_experiences_filter
  ON experiences(sensitivity, outcome, domain);

CREATE INDEX IF NOT EXISTS idx_experiences_uninternalized
  ON experiences(outcome, domain, sensitivity, confidence DESC)
  WHERE internalized_in_snapshot IS NULL;

CREATE TABLE IF NOT EXISTS experience_sources (
  experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,
  PRIMARY KEY (experience_id, source_ref)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_experience_sources_ref
  ON experience_sources(source_ref);

CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
  id UNINDEXED,
  domain,
  scope_key,
  condition,
  recommendation,
  verification,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO experiences_fts(experiences_fts, rank)
  VALUES('rank', 'bm25(0.0, 2.5, 2.0, 3.0, 2.5, 1.0)');

CREATE TABLE IF NOT EXISTS collaboration_records (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  area TEXT NOT NULL CHECK (
    area IN (
      'communication',
      'work_standards',
      'collaboration_protocol',
      'knowledge',
      'decision_values',
      'developing_taste'
    )
  ),
  kind TEXT NOT NULL CHECK (
    kind IN ('rule', 'example_positive', 'example_negative', 'criterion')
  ),
  condition TEXT NOT NULL,
  guidance TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  verification TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL,
  exceptions_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  source_roots_json TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (
    sensitivity IN ('public', 'work', 'personal', 'private')
  ),
  taint TEXT NOT NULL CHECK (taint IN ('clean', 'quoted')),
  authority_level TEXT NOT NULL CHECK (
    authority_level IN ('inferred_taste', 'observed_preference', 'owner_instruction')
  ),
  epistemic_status TEXT NOT NULL CHECK (
    epistemic_status IN ('hypothesis', 'corroborated', 'owner_instruction', 'contested', 'retracted')
  ),
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  uncertainty REAL NOT NULL CHECK (uncertainty >= 0.0 AND uncertainty <= 1.0),
  valid_from TEXT,
  valid_until TEXT,
  conflict_group TEXT,
  superseded_by TEXT,
  dedup_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_collab_records_lookup
  ON collaboration_records(person_id, partition_key, sensitivity, area, epistemic_status);

CREATE INDEX IF NOT EXISTS idx_collab_records_dedup
  ON collaboration_records(person_id, partition_key, dedup_key);

CREATE TABLE IF NOT EXISTS collaboration_record_sources (
  record_id TEXT NOT NULL REFERENCES collaboration_records(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,
  PRIMARY KEY (record_id, source_ref)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_collab_record_sources_ref
  ON collaboration_record_sources(source_ref);

CREATE TABLE IF NOT EXISTS collaboration_handoffs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  person_id TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  served_slice_hash TEXT NOT NULL,
  task TEXT NOT NULL,
  area TEXT NOT NULL CHECK (
    area IN (
      'communication',
      'work_standards',
      'collaboration_protocol',
      'knowledge',
      'decision_values',
      'developing_taste'
    )
  ),
  kind TEXT NOT NULL CHECK (
    kind IN ('agent_claim', 'owner_edit', 'owner_correction', 'observed_outcome')
  ),
  outcome_status TEXT NOT NULL CHECK (
    outcome_status IN ('unverified_agent_claim', 'observed_pass', 'observed_fail', 'owner_corrected')
  ),
  work_summary TEXT NOT NULL,
  artifact_ref TEXT NOT NULL DEFAULT '',
  correction_text TEXT NOT NULL DEFAULT '',
  supersedes_record_id TEXT,
  created_record_id TEXT,
  evidence_refs_json TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (
    sensitivity IN ('public', 'work', 'personal', 'private')
  ),
  reverted_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (person_id, partition_key, idempotency_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_collab_handoffs_lookup
  ON collaboration_handoffs(person_id, partition_key, sensitivity, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_handoff_sources (
  handoff_id TEXT NOT NULL REFERENCES collaboration_handoffs(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,
  PRIMARY KEY (handoff_id, source_ref)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_collab_handoff_sources_ref
  ON collaboration_handoff_sources(source_ref);

CREATE TABLE IF NOT EXISTS collaboration_progress (
  person_id TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('connecting', 'partial_backfill', 'complete')),
  historical_complete INTEGER NOT NULL CHECK (historical_complete IN (0, 1)),
  resume_cursor TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person_id, partition_key)
) STRICT;
`;

function enforceFileMode0600(filePath: string): void {
  if (filePath === ":memory:" || filePath === "") return;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    if (existsSync(candidate)) {
      try {
        chmodSync(candidate, 0o600);
      } catch {
        // Best-effort on filesystems that disallow chmod.
      }
    }
  }
}

function backfillExperienceSourcesIfNeeded(db: Database): void {
  const needsBackfill =
    db
      .query<{ ok: number }, []>(
        `SELECT 1 AS ok FROM experiences
         WHERE citations_json != '[]' AND citations_json != ''
           AND NOT EXISTS (SELECT 1 FROM experience_sources LIMIT 1)
         LIMIT 1`,
      )
      .get() !== null;
  if (!needsBackfill) return;

  const rows = db
    .query<{ id: string; citations_json: string }, []>(
      "SELECT id, citations_json FROM experiences WHERE citations_json != '[]' AND citations_json != ''",
    )
    .all();
  if (rows.length === 0) return;

  const insert = db.query(
    "INSERT OR IGNORE INTO experience_sources (experience_id, source_ref) VALUES (?, ?)",
  );
  const tx = db.transaction(() => {
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.citations_json);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (typeof item !== "string") continue;
        const ref = canonicalSourceRef(item);
        if (ref.length > 0) insert.run(row.id, ref);
      }
    }
  });
  tx();
}

export interface OpenMemtRegistryOptions {
  readonly busyTimeoutMs?: number;
}

export function openMemtRegistryDb(
  dbPath: string,
  options: OpenMemtRegistryOptions = {},
): Database {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 60_000
  ) {
    throw new RangeError("busyTimeoutMs must be an integer between 0 and 60000");
  }

  if (dbPath !== ":memory:" && dbPath !== "") {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  }

  const db = new Database(dbPath);
  try {
    if (process.platform === "darwin" && dbPath !== ":memory:" && dbPath !== "") {
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    }
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA temp_store = MEMORY");
    db.exec("PRAGMA cache_size = -16000");
    db.exec("PRAGMA wal_autocheckpoint = 2000");
    if (dbPath !== ":memory:" && dbPath !== "") {
      db.exec("PRAGMA mmap_size = 67108864");
    }
    db.exec(REGISTRY_SCHEMA_SQL);
    backfillExperienceSourcesIfNeeded(db);
    enforceFileMode0600(dbPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
