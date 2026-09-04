import type { Database } from "bun:sqlite";
import { PLAN_PAGE } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { resolveTimestamp } from "./time";

export interface FrameRow {
  id: number;
  timestamp: string;
  app_name: string | null;
  window_name: string | null;
  browser_url: string | null;
  device_name: string;
  focused: boolean | null;
  full_text: string | null;
  text_source: string | null;
  capture_trigger: string | null;
  snapshot_path: string | null;
  document_path: string | null;
  video_chunk_id: number | null;
  offset_index: number;
}

export interface TranscriptionRow {
  id: number;
  audio_chunk_id: number;
  offset_index: number;
  timestamp: string;
  transcription: string;
  device: string;
  is_input_device: boolean;
  speaker_id: number | null;
  speaker_name: string | null;
  transcription_engine: string;
  start_time: number | null;
  end_time: number | null;
}

interface RawFrameRow {
  id: unknown;
  timestamp: unknown;
  app_name: unknown;
  window_name: unknown;
  browser_url: unknown;
  device_name: unknown;
  focused: unknown;
  full_text: unknown;
  text_source: unknown;
  capture_trigger: unknown;
  snapshot_path: unknown;
  document_path: unknown;
  video_chunk_id: unknown;
  offset_index: unknown;
}

interface RawTranscriptionRow {
  id: unknown;
  audio_chunk_id: unknown;
  offset_index: unknown;
  timestamp: unknown;
  transcription: unknown;
  device: unknown;
  is_input_device: unknown;
  speaker_id: unknown;
  speaker_name: unknown;
  transcription_engine: unknown;
  start_time: unknown;
  end_time: unknown;
}

export function toSafeNumber(value: unknown): number | null {
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

export function readFrames(
  db: Database,
  afterId: number,
  limit: number,
  throughId?: number,
): FrameRow[] {
  if (throughId === undefined) {
    return db
      .query<RawFrameRow, [number, number]>(
        `SELECT id, timestamp, app_name, window_name, browser_url, device_name,
                focused, full_text, text_source, capture_trigger, snapshot_path,
                document_path, video_chunk_id, offset_index
           FROM frames
          WHERE id > ?
          ORDER BY id
          LIMIT ?`,
      )
      .all(afterId, limit)
      .map(mapFrameRow);
  }
  return db
    .query<RawFrameRow, [number, number, number]>(
      `SELECT id, timestamp, app_name, window_name, browser_url, device_name,
              focused, full_text, text_source, capture_trigger, snapshot_path,
              document_path, video_chunk_id, offset_index
         FROM frames
        WHERE id > ? AND id <= ?
        ORDER BY id
        LIMIT ?`,
    )
    .all(afterId, throughId, limit)
    .map(mapFrameRow);
}

export function readTranscriptions(
  db: Database,
  afterId: number,
  limit: number,
  throughId?: number,
): TranscriptionRow[] {
  if (throughId === undefined) {
    return db
      .query<RawTranscriptionRow, [number, number]>(
        `SELECT t.id, t.audio_chunk_id, t.offset_index, t.timestamp,
                t.transcription, t.device, t.is_input_device, t.speaker_id,
                s.name AS speaker_name, t.transcription_engine,
                t.start_time, t.end_time
           FROM audio_transcriptions t
           LEFT JOIN speakers s ON s.id = t.speaker_id
          WHERE t.id > ?
          ORDER BY t.id
          LIMIT ?`,
      )
      .all(afterId, limit)
      .map(mapTranscriptionRow);
  }
  return db
    .query<RawTranscriptionRow, [number, number, number]>(
      `SELECT t.id, t.audio_chunk_id, t.offset_index, t.timestamp,
              t.transcription, t.device, t.is_input_device, t.speaker_id,
              s.name AS speaker_name, t.transcription_engine,
              t.start_time, t.end_time
         FROM audio_transcriptions t
         LEFT JOIN speakers s ON s.id = t.speaker_id
        WHERE t.id > ? AND t.id <= ?
        ORDER BY t.id
        LIMIT ?`,
    )
    .all(afterId, throughId, limit)
    .map(mapTranscriptionRow);
}

export function seedAfterIds(
  db: Database,
  since: string,
  timeZone: string | null,
): { frame: number; transcription: number } {
  const normalized = new Date(since).toISOString();
  return {
    frame: maxIdBefore(db, "frames", normalized, timeZone),
    transcription: maxIdBefore(
      db,
      "audio_transcriptions",
      normalized,
      timeZone,
    ),
  };
}

function mapFrameRow(row: RawFrameRow): FrameRow {
  return {
    id: requiredRowId(row.id),
    timestamp: requiredText(row.timestamp, "frames.timestamp"),
    app_name: nullableText(row.app_name),
    window_name: nullableText(row.window_name),
    browser_url: nullableText(row.browser_url),
    device_name: requiredText(row.device_name, "frames.device_name"),
    focused: nullableBoolean(row.focused),
    full_text: nullableText(row.full_text),
    text_source: nullableText(row.text_source),
    capture_trigger: nullableText(row.capture_trigger),
    snapshot_path: nullableText(row.snapshot_path),
    document_path: nullableText(row.document_path),
    video_chunk_id: nullablePositiveId(
      row.video_chunk_id,
      "frames.video_chunk_id",
    ),
    offset_index: requiredNonNegativeInteger(
      row.offset_index,
      "frames.offset_index",
    ),
  };
}

function mapTranscriptionRow(
  row: RawTranscriptionRow,
): TranscriptionRow {
  const speakerName = nullableText(row.speaker_name);
  return {
    id: requiredRowId(row.id),
    audio_chunk_id: requiredPositiveInteger(
      row.audio_chunk_id,
      "audio_transcriptions.audio_chunk_id",
    ),
    offset_index: requiredNonNegativeInteger(
      row.offset_index,
      "audio_transcriptions.offset_index",
    ),
    timestamp: requiredText(
      row.timestamp,
      "audio_transcriptions.timestamp",
    ),
    transcription: requiredText(
      row.transcription,
      "audio_transcriptions.transcription",
    ),
    device: requiredText(row.device, "audio_transcriptions.device"),
    is_input_device: requiredBoolean(
      row.is_input_device,
      "audio_transcriptions.is_input_device",
    ),
    speaker_id: nullablePositiveId(
      row.speaker_id,
      "audio_transcriptions.speaker_id",
    ),
    speaker_name:
      speakerName !== null && speakerName.length > 0 ? speakerName : null,
    transcription_engine: requiredText(
      row.transcription_engine,
      "audio_transcriptions.transcription_engine",
    ),
    start_time: nullableFiniteNumber(row.start_time),
    end_time: nullableFiniteNumber(row.end_time),
  };
}

function maxIdBefore(
  db: Database,
  table: "frames" | "audio_transcriptions",
  since: string,
  timeZone: string | null,
): number {
  let afterId = 0;
  let maxId = 0;
  while (true) {
    const rows = db
      .query<{ id: unknown; timestamp: unknown }, [number, number]>(
        `SELECT id, timestamp FROM ${table}
          WHERE id > ?
          ORDER BY id
          LIMIT ?`,
      )
      .all(afterId, PLAN_PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = requiredCursorId(row.id);
      afterId = id;
      const resolved = resolveTimestamp(row.timestamp, timeZone);
      if ("iso" in resolved && resolved.iso < since) maxId = id;
    }
    if (rows.length < PLAN_PAGE) break;
  }
  return maxId;
}

function requiredRowId(value: unknown): number {
  const converted = toSafeNumber(value);
  if (converted === null || converted <= 0) {
    throw new ScreenpipeConnectorError(
      "parse_error",
      "kizuki.screenpipe: row id is not a safe integer",
    );
  }
  return converted;
}

function requiredCursorId(value: unknown): number {
  const converted = toSafeNumber(value);
  if (converted === null || converted < 0) {
    throw new ScreenpipeConnectorError(
      "parse_error",
      "kizuki.screenpipe: row id is not a safe integer",
    );
  }
  return converted;
}

function requiredPositiveInteger(value: unknown, column: string): number {
  const converted = toSafeNumber(value);
  if (converted === null || converted <= 0) invalidColumn(column);
  return converted;
}

function requiredNonNegativeInteger(
  value: unknown,
  column: string,
): number {
  const converted = toSafeNumber(value);
  if (converted === null || converted < 0) invalidColumn(column);
  return converted;
}

function nullablePositiveId(
  value: unknown,
  column: string,
): number | null {
  if (value === null) return null;
  return requiredPositiveInteger(value, column);
}

function requiredText(value: unknown, column: string): string {
  if (typeof value !== "string") invalidColumn(column);
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredBoolean(value: unknown, column: string): boolean {
  const decoded = nullableBoolean(value);
  if (decoded === null) invalidColumn(column);
  return decoded;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  return null;
}

function nullableFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return null;
}

function invalidColumn(column: string): never {
  throw new ScreenpipeConnectorError(
    "parse_error",
    `kizuki.screenpipe: ${column} has an invalid value`,
  );
}
