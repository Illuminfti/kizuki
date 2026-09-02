import type { Database } from "bun:sqlite";
import { MAX_TEXT_CHARS } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { cutText } from "./text";

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

/**
 * Every TEXT column here is provider-controlled and unbounded in the file, so
 * the value is cut in SQLite rather than read whole and cut afterwards. One
 * character past the event limit is kept so truncation is still detectable,
 * and a column holding something other than text is passed through unchanged
 * so it still fails its own validation. SQLite counts code points here, so the
 * readers cut again in code units — the unit every bound downstream counts.
 */
function bounded(column: string, alias = column): string {
  return `CASE WHEN typeof(${column}) = 'text'
               THEN substr(${column}, 1, ${MAX_TEXT_CHARS + 1})
               ELSE ${column} END AS ${alias}`;
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

const FRAME_COLUMNS = [
  "id",
  bounded("timestamp"),
  bounded("app_name"),
  bounded("window_name"),
  bounded("browser_url"),
  bounded("device_name"),
  "focused",
  bounded("full_text"),
  bounded("text_source"),
  bounded("capture_trigger"),
  bounded("snapshot_path"),
  bounded("document_path"),
  "video_chunk_id",
  "offset_index",
].join(", ");

const TRANSCRIPTION_COLUMNS = [
  "t.id",
  "t.audio_chunk_id",
  "t.offset_index",
  bounded("t.timestamp", "timestamp"),
  bounded("t.transcription", "transcription"),
  bounded("t.device", "device"),
  "t.is_input_device",
  "t.speaker_id",
  bounded("s.name", "speaker_name"),
  bounded("t.transcription_engine", "transcription_engine"),
  "t.start_time",
  "t.end_time",
].join(", ");

export function readFrames(
  db: Database,
  afterId: number,
  limit: number,
): FrameRow[] {
  return db
    .query<RawFrameRow, [number, number]>(
      `SELECT ${FRAME_COLUMNS}
         FROM frames
        WHERE id > ?
        ORDER BY id
        LIMIT ?`,
    )
    .all(afterId, limit)
    .map(mapFrameRow);
}

export function readTranscriptions(
  db: Database,
  afterId: number,
  limit: number,
): TranscriptionRow[] {
  return db
    .query<RawTranscriptionRow, [number, number]>(
      `SELECT ${TRANSCRIPTION_COLUMNS}
         FROM audio_transcriptions t
         LEFT JOIN speakers s ON s.id = t.speaker_id
        WHERE t.id > ?
        ORDER BY t.id
        LIMIT ?`,
    )
    .all(afterId, limit)
    .map(mapTranscriptionRow);
}

/**
 * A day, subtracted from the cutoff before it is compared against raw column
 * text. A row written with its own zone offset sorts by local time, which can
 * put a row that is at or after the cutoff in UTC below the cutoff's own text.
 * Every offset RFC3339 allows is inside this slack.
 */
const PROBE_SLACK_MS = 86_400_000;

export function seedAfterIds(
  db: Database,
  since: string,
): { frame: number; transcription: number } {
  // The walk applies `since` to every row it reads, so this seed only has to be
  // conservative: starting earlier than necessary costs a few reads, starting
  // later loses history for good. It is an index probe for the common case
  // where id order follows timestamp order, never the guarantee.
  //
  // Rows carry either the RFC3339 encoding sqlx writes today or the legacy
  // space-separated one, and the two do not sort against each other, so the
  // probe asks both.
  const probe = new Date(Date.parse(since) - PROBE_SLACK_MS).toISOString();
  return {
    frame: seedBefore(db, "frames", probe),
    transcription: seedBefore(db, "audio_transcriptions", probe),
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
    video_chunk_id: nullablePositiveId(row.video_chunk_id),
    offset_index: degradedOffset(row.offset_index),
  };
}

function mapTranscriptionRow(
  row: RawTranscriptionRow,
): TranscriptionRow {
  const speakerName = nullableText(row.speaker_name);
  return {
    id: requiredRowId(row.id),
    audio_chunk_id: degradedOffset(row.audio_chunk_id),
    offset_index: degradedOffset(row.offset_index),
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
    speaker_id: nullablePositiveId(row.speaker_id),
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

function seedBefore(
  db: Database,
  table: "frames" | "audio_transcriptions",
  probe: string,
): number {
  const first = db
    .query<{ id: unknown }, [string, string]>(
      `SELECT COALESCE(MIN(id), 0) AS id FROM ${table}
        WHERE timestamp >= ? OR timestamp >= ?`,
    )
    .get(probe, legacyForm(probe));
  const firstAfter = requiredCursorId(first?.id);
  if (firstAfter > 0) return firstAfter - 1;
  // No row can be at or after the cutoff under either encoding, so every row
  // the walk would read is older than it and the table can be seeded past.
  return maxId(db, table);
}

function legacyForm(iso: string): string {
  return iso.replace("T", " ");
}

function maxId(
  db: Database,
  table: "frames" | "audio_transcriptions",
): number {
  const row = db
    .query<{ id: unknown }, []>(
      `SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`,
    )
    .get();
  return requiredCursorId(row?.id);
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

/**
 * `offset_index` and `audio_chunk_id` position a row inside its capture; they
 * are not part of the identity this connector reads by, and the spec's
 * fail-closed set does not include them. Failing on one would abandon every
 * batch behind the row for good, so an unusable value reads as 0 and travels
 * to the event's metadata as such.
 */
function degradedOffset(value: unknown): number {
  const converted = toSafeNumber(value);
  return converted !== null && converted > 0 ? converted : 0;
}

// `frames.video_chunk_id` and `audio_transcriptions.speaker_id` are optional
// links the spec types `number | null`. A value that is not a usable row id
// means the row carries no link; failing the read would abandon the whole
// batch, including the sound rows around it, with no way to make progress.
function nullablePositiveId(value: unknown): number | null {
  const converted = toSafeNumber(value);
  return converted !== null && converted > 0 ? converted : null;
}

function requiredText(value: unknown, column: string): string {
  if (typeof value !== "string") invalidColumn(column);
  return cutText(value, MAX_TEXT_CHARS + 1);
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? cutText(value, MAX_TEXT_CHARS + 1) : null;
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
