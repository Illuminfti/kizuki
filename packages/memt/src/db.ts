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

CREATE INDEX IF NOT EXISTS idx_experiences_sensitivity
  ON experiences(sensitivity);

CREATE INDEX IF NOT EXISTS idx_experiences_internalized
  ON experiences(internalized_in_snapshot);

CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
  id UNINDEXED,
  domain,
  scope_key,
  condition,
  recommendation,
  verification,
  tokenize = 'unicode61 remove_diacritics 2'
);
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
    db.exec(REGISTRY_SCHEMA_SQL);
    enforceFileMode0600(dbPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
