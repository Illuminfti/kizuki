import type { Database } from "bun:sqlite";
import { ScreenpipeConnectorError } from "./errors";

export const SCREENPIPE_SCHEMA_FLOOR = 20260613130000;
export const SCREENPIPE_SCHEMA_VERIFIED = 20260828143000;

export type ColumnAffinity = "INTEGER" | "TEXT" | "REAL" | "NUMERIC";

export interface ColumnContract {
  name: string;
  affinity: ColumnAffinity;
  /** `pk` accepts SQLite's INTEGER PRIMARY KEY notnull=0 quirk. */
  notnull: boolean | "pk";
}

export const REQUIRED_COLUMN_CONTRACTS = {
  frames: [
    { name: "id", affinity: "INTEGER", notnull: "pk" },
    { name: "timestamp", affinity: "NUMERIC", notnull: true },
    { name: "app_name", affinity: "TEXT", notnull: false },
    { name: "window_name", affinity: "TEXT", notnull: false },
    { name: "browser_url", affinity: "TEXT", notnull: false },
    { name: "device_name", affinity: "TEXT", notnull: true },
    { name: "focused", affinity: "NUMERIC", notnull: false },
    { name: "full_text", affinity: "TEXT", notnull: false },
    { name: "text_source", affinity: "TEXT", notnull: false },
    { name: "capture_trigger", affinity: "TEXT", notnull: false },
    { name: "snapshot_path", affinity: "TEXT", notnull: false },
    { name: "document_path", affinity: "TEXT", notnull: false },
    { name: "video_chunk_id", affinity: "INTEGER", notnull: false },
    { name: "offset_index", affinity: "INTEGER", notnull: true },
  ],
  audio_transcriptions: [
    { name: "id", affinity: "INTEGER", notnull: "pk" },
    { name: "audio_chunk_id", affinity: "INTEGER", notnull: true },
    { name: "offset_index", affinity: "INTEGER", notnull: true },
    { name: "timestamp", affinity: "NUMERIC", notnull: true },
    { name: "transcription", affinity: "TEXT", notnull: true },
    { name: "device", affinity: "TEXT", notnull: true },
    { name: "is_input_device", affinity: "NUMERIC", notnull: true },
    { name: "speaker_id", affinity: "INTEGER", notnull: false },
    { name: "transcription_engine", affinity: "TEXT", notnull: true },
    { name: "start_time", affinity: "REAL", notnull: false },
    { name: "end_time", affinity: "REAL", notnull: false },
  ],
  audio_chunks: [
    { name: "id", affinity: "INTEGER", notnull: "pk" },
    { name: "file_path", affinity: "TEXT", notnull: true },
    { name: "timestamp", affinity: "NUMERIC", notnull: false },
  ],
  speakers: [
    { name: "id", affinity: "INTEGER", notnull: "pk" },
    { name: "name", affinity: "TEXT", notnull: false },
  ],
} as const satisfies Record<string, readonly ColumnContract[]>;

export const REQUIRED_COLUMNS: {
  [K in keyof typeof REQUIRED_COLUMN_CONTRACTS]: readonly string[];
} = {
  frames: REQUIRED_COLUMN_CONTRACTS.frames.map((column) => column.name),
  audio_transcriptions: REQUIRED_COLUMN_CONTRACTS.audio_transcriptions.map(
    (column) => column.name,
  ),
  audio_chunks: REQUIRED_COLUMN_CONTRACTS.audio_chunks.map(
    (column) => column.name,
  ),
  speakers: REQUIRED_COLUMN_CONTRACTS.speakers.map((column) => column.name),
};

export const REQUIRED_INDEXES = [
  { table: "frames", columns: ["timestamp"] },
  { table: "audio_transcriptions", columns: ["timestamp"] },
] as const;

export interface SchemaReport {
  ok: boolean;
  migrations_table: boolean;
  floor_applied: boolean;
  max_migration: number | null;
  newer_than_verified: boolean;
  missing: string[];
  incompatible: string[];
  missing_indexes: string[];
  detail: string;
}

interface ScalarRow {
  value: unknown;
}

interface PragmaColumn {
  name: unknown;
  type: unknown;
  notnull: unknown;
  pk: unknown;
}

interface PragmaIndex {
  name: unknown;
  origin: unknown;
}

interface PragmaIndexInfo {
  name: unknown;
}

export function inspectSchema(db: Database): SchemaReport {
  const migrationsTable =
    db
      .query<{ name: string }, []>(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'table' AND name = '_sqlx_migrations'`,
      )
      .get() !== null;

  let floorApplied = false;
  let maxMigration: number | null = null;
  let invalidMaxMigration = false;
  if (migrationsTable) {
    const floor = db
      .query<ScalarRow, [number]>(
        `SELECT COUNT(*) AS value
           FROM _sqlx_migrations
          WHERE version = ? AND success = 1`,
      )
      .get(SCREENPIPE_SCHEMA_FLOOR);
    floorApplied = numericValue(floor?.value ?? null) > 0;
    const max = db
      .query<ScalarRow, []>(
        `SELECT MAX(version) AS value
           FROM _sqlx_migrations
          WHERE success = 1`,
      )
      .get();
    const rawMax = max?.value ?? null;
    maxMigration = nullableSafeNumber(rawMax);
    invalidMaxMigration = rawMax !== null && maxMigration === null;
  }

  const missing: string[] = [];
  const incompatible: string[] = [];
  for (const [table, required] of Object.entries(REQUIRED_COLUMN_CONTRACTS)) {
    const rows = db.query<PragmaColumn, []>(`PRAGMA table_info(${table})`).all();
    const actual = new Map<string, PragmaColumn>();
    for (const row of rows) {
      if (typeof row.name === "string") actual.set(row.name, row);
    }
    for (const column of required) {
      const found = actual.get(column.name);
      if (found === undefined) {
        missing.push(`${table}.${column.name}`);
        continue;
      }
      const mismatch = columnMismatch(table, column, found);
      if (mismatch !== null) incompatible.push(mismatch);
    }
  }
  missing.sort();
  incompatible.sort();

  const missingIndexes = REQUIRED_INDEXES.filter(
    (index) => !hasCoveringIndex(db, index.table, index.columns),
  ).map((index) => `${index.table}(${index.columns.join(",")})`);

  const newerThanVerified =
    maxMigration !== null && maxMigration > SCREENPIPE_SCHEMA_VERIFIED;
  const ok =
    migrationsTable &&
    floorApplied &&
    !invalidMaxMigration &&
    missing.length === 0 &&
    incompatible.length === 0 &&
    missingIndexes.length === 0;
  return {
    ok,
    migrations_table: migrationsTable,
    floor_applied: floorApplied,
    max_migration: maxMigration,
    newer_than_verified: newerThanVerified,
    missing,
    incompatible,
    missing_indexes: missingIndexes,
    detail: schemaDetail({
      migrationsTable,
      floorApplied,
      invalidMaxMigration,
      maxMigration,
      newerThanVerified,
      missing,
      incompatible,
      missingIndexes,
    }),
  };
}

export function assertSchema(db: Database): SchemaReport {
  const report = inspectSchema(db);
  if (!report.ok) {
    throw new ScreenpipeConnectorError("schema_mismatch", report.detail);
  }
  return report;
}

export function sqliteAffinity(declaredType: unknown): string | null {
  if (typeof declaredType !== "string") return null;
  const type = declaredType.toUpperCase();
  if (type.includes("INT")) return "INTEGER";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) {
    return "TEXT";
  }
  if (type.includes("BLOB")) return "BLOB";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) {
    return "REAL";
  }
  return "NUMERIC";
}

function columnMismatch(
  table: string,
  expected: ColumnContract,
  actual: PragmaColumn,
): string | null {
  const affinity = sqliteAffinity(actual.type);
  if (affinity !== expected.affinity) {
    return `${table}.${expected.name} expected ${expected.affinity} affinity`;
  }
  const pk = numericValue(actual.pk) > 0;
  const notnull = numericValue(actual.notnull) > 0;
  if (expected.notnull === "pk") {
    if (!pk) return `${table}.${expected.name} expected primary key`;
    return null;
  }
  if (expected.notnull && !notnull && !pk) {
    return `${table}.${expected.name} expected NOT NULL`;
  }
  if (!expected.notnull && notnull) {
    return `${table}.${expected.name} expected nullable`;
  }
  return null;
}

function hasCoveringIndex(
  db: Database,
  table: string,
  columns: readonly string[],
): boolean {
  const indexes = db
    .query<PragmaIndex, []>(`PRAGMA index_list(${table})`)
    .all();
  for (const index of indexes) {
    if (typeof index.name !== "string") continue;
    const info = db
      .query<PragmaIndexInfo, []>(`PRAGMA index_info(${index.name})`)
      .all()
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string");
    if (startsWith(info, columns)) return true;
  }
  const tableInfo = db.query<PragmaColumn, []>(`PRAGMA table_info(${table})`).all();
  const pk = tableInfo
    .filter((row) => numericValue(row.pk) > 0)
    .sort((left, right) => numericValue(left.pk) - numericValue(right.pk))
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
  return startsWith(pk, columns);
}

function startsWith(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length >= expected.length &&
    expected.every((column, index) => actual[index] === column)
  );
}

function schemaDetail(state: {
  migrationsTable: boolean;
  floorApplied: boolean;
  invalidMaxMigration: boolean;
  maxMigration: number | null;
  newerThanVerified: boolean;
  missing: string[];
  incompatible: string[];
  missingIndexes: string[];
}): string {
  if (!state.migrationsTable) {
    return "not a screenpipe database (no _sqlx_migrations table)";
  }
  if (state.invalidMaxMigration) {
    return "screenpipe schema mismatch: invalid migration version";
  }
  if (!state.floorApplied) {
    return (
      `screenpipe schema older than supported: migration ${SCREENPIPE_SCHEMA_FLOOR} ` +
      `not applied (max ${state.maxMigration ?? "none"}); update screenpipe`
    );
  }
  if (state.missing.length > 0) {
    return `screenpipe schema mismatch: missing ${state.missing.join(", ")}`;
  }
  if (state.incompatible.length > 0) {
    return `screenpipe schema mismatch: ${state.incompatible.join(", ")}`;
  }
  if (state.missingIndexes.length > 0) {
    return `screenpipe schema mismatch: missing index ${state.missingIndexes.join(", ")}`;
  }
  if (state.newerThanVerified) {
    return (
      `screenpipe schema newer than verified: max migration ${state.maxMigration} > ` +
      `${SCREENPIPE_SCHEMA_VERIFIED}; required columns present`
    );
  }
  return `screenpipe schema verified (max migration ${state.maxMigration})`;
}

function numericValue(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" ? value : 0;
}

function nullableSafeNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" && typeof value !== "bigint") return null;
  const converted = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(converted) ? converted : null;
}
