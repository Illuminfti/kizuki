import type { Database } from "bun:sqlite";
import { ScreenpipeConnectorError } from "./errors";

export const SCREENPIPE_SCHEMA_FLOOR = 20260613130000;
export const SCREENPIPE_SCHEMA_VERIFIED = 20260828143000;

export const REQUIRED_COLUMNS = {
  frames: [
    "id",
    "timestamp",
    "app_name",
    "window_name",
    "browser_url",
    "device_name",
    "focused",
    "full_text",
    "text_source",
    "capture_trigger",
    "snapshot_path",
    "document_path",
    "video_chunk_id",
    "offset_index",
  ],
  audio_transcriptions: [
    "id",
    "audio_chunk_id",
    "offset_index",
    "timestamp",
    "transcription",
    "device",
    "is_input_device",
    "speaker_id",
    "transcription_engine",
    "start_time",
    "end_time",
  ],
  audio_chunks: ["id", "file_path", "timestamp"],
  speakers: ["id", "name"],
} as const satisfies Record<string, readonly string[]>;

export interface SchemaReport {
  ok: boolean;
  migrations_table: boolean;
  floor_applied: boolean;
  max_migration: number | null;
  newer_than_verified: boolean;
  missing: string[];
  detail: string;
}

interface ScalarRow {
  value: unknown;
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
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const rows = db
      .query<{ name: unknown }, []>(`PRAGMA table_info(${table})`)
      .all();
    const actual = new Set(
      rows
        .map(({ name }) => name)
        .filter((name): name is string => typeof name === "string"),
    );
    for (const column of required) {
      if (!actual.has(column)) missing.push(`${table}.${column}`);
    }
  }
  missing.sort();

  const newerThanVerified =
    maxMigration !== null && maxMigration > SCREENPIPE_SCHEMA_VERIFIED;
  const ok =
    migrationsTable &&
    floorApplied &&
    !invalidMaxMigration &&
    missing.length === 0;
  return {
    ok,
    migrations_table: migrationsTable,
    floor_applied: floorApplied,
    max_migration: maxMigration,
    newer_than_verified: newerThanVerified,
    missing,
    detail: schemaDetail({
      migrationsTable,
      floorApplied,
      invalidMaxMigration,
      maxMigration,
      newerThanVerified,
      missing,
    }),
  };
}

export function assertSchema(db: Database): SchemaReport {
  const report = inspectSchema(db);
  if (!report.ok) {
    throw new ScreenpipeConnectorError(
      "schema_mismatch",
      report.detail,
    );
  }
  return report;
}

function schemaDetail(state: {
  migrationsTable: boolean;
  floorApplied: boolean;
  invalidMaxMigration: boolean;
  maxMigration: number | null;
  newerThanVerified: boolean;
  missing: string[];
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
