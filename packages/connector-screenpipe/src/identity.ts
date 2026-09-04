import type { Database } from "bun:sqlite";
import { ScreenpipeConnectorError } from "./errors";
import { toSafeNumber } from "./read";

export interface DatabaseIdentity {
  path: string;
  fingerprint: string;
  max_frame_id: number;
  max_transcription_id: number;
}

export function inspectIdentity(
  db: Database,
  resolvedPath: string,
): DatabaseIdentity {
  return {
    path: resolvedPath,
    fingerprint: schemaFingerprint(db),
    max_frame_id: tableMaxId(db, "frames"),
    max_transcription_id: tableMaxId(db, "audio_transcriptions"),
  };
}

export function schemaFingerprint(db: Database): string {
  const first = db
    .query<{ version: unknown; installed_on: unknown }, []>(
      `SELECT version, installed_on
         FROM _sqlx_migrations
        WHERE success = 1
        ORDER BY version
        LIMIT 1`,
    )
    .get();
  const payload =
    first === undefined || first === null
      ? "none"
      : `${jsonSafe(first.version)}\0${String(first.installed_on)}`;
  return new Bun.CryptoHasher("sha256").update(payload).digest("hex");
}

export function tableMaxId(
  db: Database,
  table: "frames" | "audio_transcriptions",
): number {
  const row = db
    .query<{ id: unknown }, []>(
      `SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`,
    )
    .get();
  const id = toSafeNumber(row?.id);
  if (id === null || id < 0) {
    throw new ScreenpipeConnectorError(
      "parse_error",
      "kizuki.screenpipe: row id is not a safe integer",
    );
  }
  return id;
}

function jsonSafe(value: unknown): string | number | boolean | null {
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : value.toString();
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}
