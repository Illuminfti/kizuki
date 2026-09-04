import type { Database } from "bun:sqlite";
import { ScreenpipeConnectorError } from "./errors";
import { toSafeNumber } from "./read";
import { REQUIRED_COLUMN_CONTRACTS } from "./schema";

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
  const parts: string[] = [];
  for (const table of Object.keys(REQUIRED_COLUMN_CONTRACTS)) {
    const columns = db
      .query<{ name: unknown; type: unknown; notnull: unknown; pk: unknown }, []>(
        `PRAGMA table_info(${table})`,
      )
      .all()
      .map((row) => ({
        name: row.name,
        type: row.type,
        notnull: jsonSafe(row.notnull),
        pk: jsonSafe(row.pk),
      }));
    parts.push(`${table}:${JSON.stringify(columns)}`);
    const indexes = db
      .query<{ name: unknown; origin: unknown }, []>(
        `PRAGMA index_list(${table})`,
      )
      .all()
      .map((row) => ({ name: row.name, origin: row.origin }));
    parts.push(`indexes:${table}:${JSON.stringify(indexes)}`);
  }
  const first = db
    .query<{ version: unknown; installed_on: unknown }, []>(
      `SELECT version, installed_on
         FROM _sqlx_migrations
        WHERE success = 1
        ORDER BY version
        LIMIT 1`,
    )
    .get();
  parts.push(
    `migration:${JSON.stringify(
      first === undefined || first === null
        ? null
        : { version: jsonSafe(first.version), installed_on: first.installed_on },
    )}`,
  );
  return new Bun.CryptoHasher("sha256").update(parts.join("|")).digest("hex");
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

export function assertCompatibleIdentity(
  cursorPath: string,
  cursorFingerprint: string,
  highWaterFrame: number,
  highWaterTranscription: number,
  lastFrameId: number,
  lastTranscriptionId: number,
  identity: DatabaseIdentity,
): void {
  if (
    cursorPath !== identity.path ||
    cursorFingerprint !== identity.fingerprint ||
    identity.max_frame_id < lastFrameId ||
    identity.max_transcription_id < lastTranscriptionId ||
    identity.max_frame_id < highWaterFrame ||
    identity.max_transcription_id < highWaterTranscription
  ) {
    throw new ScreenpipeConnectorError(
      "reset_detected",
      "kizuki.screenpipe: source database was replaced, rewound, or rebound; enroll a new connection and rebackfill",
    );
  }
}
