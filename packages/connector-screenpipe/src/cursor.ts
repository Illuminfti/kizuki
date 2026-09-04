import { isPlainObject } from "@kizuki/core";
import { ScreenpipeConnectorError } from "./errors";
import type { DatabaseIdentity } from "./identity";

export const SCREENPIPE_CURSOR_SCHEMA =
  "kizuki.screenpipe-cursor/v2" as const;

export const CURSOR_PHASES = ["continue", "caught_up", "exhausted"] as const;
export type CursorPhase = (typeof CURSOR_PHASES)[number];

export interface SkippedCounters {
  frames_without_text: number;
  frames_bad_timestamp: number;
  frames_offset_unknown: number;
  transcriptions_bad_timestamp: number;
  transcriptions_bad_offset: number;
  transcriptions_offset_unknown: number;
}

export interface ScreenpipeCursor {
  schema: typeof SCREENPIPE_CURSOR_SCHEMA;
  last_frame_id: number;
  last_transcription_id: number;
  skipped: SkippedCounters;
  db_path: string;
  db_fingerprint: string;
  high_water_frame: number;
  high_water_transcription: number;
  snapshot_frame_max: number;
  snapshot_transcription_max: number;
  oldest_skipped_frame_id: number;
  oldest_skipped_transcription_id: number;
  phase: CursorPhase;
}

export const BATCH_LIMIT = 500;
export const MAX_TEXT_CHARS = 65_536;
export const DEFAULT_SETTLE_SECONDS = 300;
export const MAX_PLAN_IDS = 10_000;
export const PLAN_PAGE = 5_000;
export const DISTINCT_SCAN_CAP = 1_000;
export const PLAN_DEADLINE_MS = 2_000;
export const SKIP_DEGRADE_THRESHOLD = 1;

const TOP_LEVEL_KEYS = [
  "schema",
  "last_frame_id",
  "last_transcription_id",
  "skipped",
  "db_path",
  "db_fingerprint",
  "high_water_frame",
  "high_water_transcription",
  "snapshot_frame_max",
  "snapshot_transcription_max",
  "oldest_skipped_frame_id",
  "oldest_skipped_transcription_id",
  "phase",
] as const;

const SKIPPED_KEYS = [
  "frames_without_text",
  "frames_bad_timestamp",
  "frames_offset_unknown",
  "transcriptions_bad_timestamp",
  "transcriptions_bad_offset",
  "transcriptions_offset_unknown",
] as const;

export function emptySkipped(): SkippedCounters {
  return {
    frames_without_text: 0,
    frames_bad_timestamp: 0,
    frames_offset_unknown: 0,
    transcriptions_bad_timestamp: 0,
    transcriptions_bad_offset: 0,
    transcriptions_offset_unknown: 0,
  };
}

export function parseSkipTotal(skipped: SkippedCounters): number {
  return (
    skipped.frames_bad_timestamp +
    skipped.frames_offset_unknown +
    skipped.transcriptions_bad_timestamp +
    skipped.transcriptions_bad_offset +
    skipped.transcriptions_offset_unknown
  );
}

export function initialCursor(
  identity: DatabaseIdentity,
  afterIds?: { frame: number; transcription: number },
): ScreenpipeCursor {
  const frame = afterIds?.frame ?? 0;
  const transcription = afterIds?.transcription ?? 0;
  if (!isCounter(frame) || !isCounter(transcription)) malformedCursor();
  return canonicalCursor({
    schema: SCREENPIPE_CURSOR_SCHEMA,
    last_frame_id: frame,
    last_transcription_id: transcription,
    skipped: emptySkipped(),
    db_path: identity.path,
    db_fingerprint: identity.fingerprint,
    high_water_frame: identity.max_frame_id,
    high_water_transcription: identity.max_transcription_id,
    snapshot_frame_max: identity.max_frame_id,
    snapshot_transcription_max: identity.max_transcription_id,
    oldest_skipped_frame_id: 0,
    oldest_skipped_transcription_id: 0,
    phase: "continue",
  });
}

export function parseCursor(cursor: string): ScreenpipeCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    throw new ScreenpipeConnectorError(
      "parse_error",
      "kizuki.screenpipe: malformed cursor",
      { cause: error },
    );
  }
  if (
    !isPlainObject(parsed) ||
    !hasExactKeys(parsed, TOP_LEVEL_KEYS) ||
    parsed["schema"] !== SCREENPIPE_CURSOR_SCHEMA ||
    !isCounter(parsed["last_frame_id"]) ||
    !isCounter(parsed["last_transcription_id"]) ||
    !isNonEmptyString(parsed["db_path"]) ||
    !isFingerprint(parsed["db_fingerprint"]) ||
    !isCounter(parsed["high_water_frame"]) ||
    !isCounter(parsed["high_water_transcription"]) ||
    !isCounter(parsed["snapshot_frame_max"]) ||
    !isCounter(parsed["snapshot_transcription_max"]) ||
    !isCounter(parsed["oldest_skipped_frame_id"]) ||
    !isCounter(parsed["oldest_skipped_transcription_id"]) ||
    !isPhase(parsed["phase"])
  ) {
    malformedCursor();
  }
  const skipped = parsed["skipped"];
  if (
    !isPlainObject(skipped) ||
    !hasExactKeys(skipped, SKIPPED_KEYS) ||
    !isCounter(skipped["frames_without_text"]) ||
    !isCounter(skipped["frames_bad_timestamp"]) ||
    !isCounter(skipped["frames_offset_unknown"]) ||
    !isCounter(skipped["transcriptions_bad_timestamp"]) ||
    !isCounter(skipped["transcriptions_bad_offset"]) ||
    !isCounter(skipped["transcriptions_offset_unknown"])
  ) {
    malformedCursor();
  }
  return canonicalCursor({
    schema: SCREENPIPE_CURSOR_SCHEMA,
    last_frame_id: parsed["last_frame_id"],
    last_transcription_id: parsed["last_transcription_id"],
    skipped: {
      frames_without_text: skipped["frames_without_text"],
      frames_bad_timestamp: skipped["frames_bad_timestamp"],
      frames_offset_unknown: skipped["frames_offset_unknown"],
      transcriptions_bad_timestamp: skipped["transcriptions_bad_timestamp"],
      transcriptions_bad_offset: skipped["transcriptions_bad_offset"],
      transcriptions_offset_unknown: skipped["transcriptions_offset_unknown"],
    },
    db_path: parsed["db_path"],
    db_fingerprint: parsed["db_fingerprint"],
    high_water_frame: parsed["high_water_frame"],
    high_water_transcription: parsed["high_water_transcription"],
    snapshot_frame_max: parsed["snapshot_frame_max"],
    snapshot_transcription_max: parsed["snapshot_transcription_max"],
    oldest_skipped_frame_id: parsed["oldest_skipped_frame_id"],
    oldest_skipped_transcription_id: parsed["oldest_skipped_transcription_id"],
    phase: parsed["phase"],
  });
}

export function encodeCursor(cursor: ScreenpipeCursor): string {
  const checked = parseCursor(JSON.stringify(canonicalCursor(cursor)));
  return JSON.stringify(checked);
}

export function replayFrom(
  cursor: ScreenpipeCursor,
  from: { frame?: number; transcription?: number },
): ScreenpipeCursor {
  const frame = from.frame ?? cursor.last_frame_id;
  const transcription = from.transcription ?? cursor.last_transcription_id;
  if (!isCounter(frame) || !isCounter(transcription)) {
    throw new ScreenpipeConnectorError(
      "misconfigured",
      "kizuki.screenpipe: replay ids must be safe non-negative integers",
    );
  }
  return canonicalCursor({
    ...cursor,
    last_frame_id: frame,
    last_transcription_id: transcription,
    phase: "continue",
  });
}

export function recordSkippedFrame(cursor: ScreenpipeCursor, id: number): void {
  if (cursor.oldest_skipped_frame_id === 0 || id < cursor.oldest_skipped_frame_id) {
    cursor.oldest_skipped_frame_id = id;
  }
}

export function recordSkippedTranscription(
  cursor: ScreenpipeCursor,
  id: number,
): void {
  if (
    cursor.oldest_skipped_transcription_id === 0 ||
    id < cursor.oldest_skipped_transcription_id
  ) {
    cursor.oldest_skipped_transcription_id = id;
  }
}

export function canonicalCursor(cursor: ScreenpipeCursor): ScreenpipeCursor {
  return {
    schema: SCREENPIPE_CURSOR_SCHEMA,
    last_frame_id: cursor.last_frame_id,
    last_transcription_id: cursor.last_transcription_id,
    skipped: {
      frames_without_text: cursor.skipped.frames_without_text,
      frames_bad_timestamp: cursor.skipped.frames_bad_timestamp,
      frames_offset_unknown: cursor.skipped.frames_offset_unknown,
      transcriptions_bad_timestamp: cursor.skipped.transcriptions_bad_timestamp,
      transcriptions_bad_offset: cursor.skipped.transcriptions_bad_offset,
      transcriptions_offset_unknown:
        cursor.skipped.transcriptions_offset_unknown,
    },
    db_path: cursor.db_path,
    db_fingerprint: cursor.db_fingerprint,
    high_water_frame: cursor.high_water_frame,
    high_water_transcription: cursor.high_water_transcription,
    snapshot_frame_max: cursor.snapshot_frame_max,
    snapshot_transcription_max: cursor.snapshot_transcription_max,
    oldest_skipped_frame_id: cursor.oldest_skipped_frame_id,
    oldest_skipped_transcription_id: cursor.oldest_skipped_transcription_id,
    phase: cursor.phase,
  };
}

function isCounter(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isPhase(value: unknown): value is CursorPhase {
  return (
    typeof value === "string" &&
    (CURSOR_PHASES as readonly string[]).includes(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function malformedCursor(): never {
  throw new ScreenpipeConnectorError(
    "parse_error",
    "kizuki.screenpipe: malformed cursor",
  );
}
