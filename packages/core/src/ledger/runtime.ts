import type { Database } from "bun:sqlite";
import { oneShotGet } from "./schema";

export interface SqliteRuntime {
  schema: "kizuki.sqlite-runtime/v1";
  bun_version: string;
  sqlite_version: string;
  sqlite_source_id: string;
}

function runtimeString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= limit && value.trim() === value && /^[\x20-\x7e]+$/.test(value);
}

/** Validate the observation's shape and bounds, without qualifying an engine. */
export function parseSqliteRuntime(value: unknown): SqliteRuntime {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid SQLite runtime observation");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 4 || keys.sort().join(",") !== "bun_version,schema,sqlite_source_id,sqlite_version" ||
      row.schema !== "kizuki.sqlite-runtime/v1" ||
      !runtimeString(row.bun_version, 64) || !runtimeString(row.sqlite_version, 64) ||
      !runtimeString(row.sqlite_source_id, 256)) {
    throw new Error("invalid SQLite runtime observation");
  }
  return {
    schema: row.schema,
    bun_version: row.bun_version,
    sqlite_version: row.sqlite_version,
    sqlite_source_id: row.sqlite_source_id,
  };
}

/** Observe the effective ledger connection; never load or open another engine. */
export function readSqliteRuntime(db: Database): SqliteRuntime {
  try {
    const row = oneShotGet<Record<string, unknown>>(
      db,
      "SELECT sqlite_version() AS sqlite_version, sqlite_source_id() AS sqlite_source_id",
    );
    return parseSqliteRuntime({
      ...row, schema: "kizuki.sqlite-runtime/v1", bun_version: Bun.version,
    });
  } catch {
    throw new Error("SQLite runtime observation unavailable");
  }
}
