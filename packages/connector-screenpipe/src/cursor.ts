import { isPlainObject } from "@kizuki/core";
import { ScreenpipeConnectorError } from "./errors";

export const SCREENPIPE_CURSOR_SCHEMA = "kizuki.screenpipe-cursor/v1" as const;

export interface SkippedCounters {
  frames_without_text: number;
  frames_bad_timestamp: number;
  transcriptions_bad_timestamp: number;
}

export interface ScreenpipeCursor {
  schema: typeof SCREENPIPE_CURSOR_SCHEMA;
  last_frame_id: number;
  last_transcription_id: number;
  skipped: SkippedCounters;
}

export const BATCH_LIMIT = 500;
/**
 * Places in a batch that frames may not take while transcriptions are unread.
 * Screen capture runs at about a frame a second and does not stop while the
 * machine is in use, so with no reserve the frame table fills every batch on
 * its own and the audio table is read only once the screen goes quiet.
 */
export const TRANSCRIPTION_RESERVE = 100;
export const MAX_TEXT_CHARS = 65_536;
/**
 * Characters of a name that reach a subject id. A purge plan has to derive
 * the same id from the same row, so both sides read the same bounded prefix
 * rather than the whole provider-controlled column.
 */
export const MAX_SUBJECT_CHARS = 1_024;
/**
 * Characters of a metadata or display string that reach an event. Only `text`
 * carries a whole screen; a window title, a URL, a device name or a path does
 * not, and reading them at the text bound lets one batch carry hundreds of
 * megabytes of them while every event's own text is a few characters. Never
 * below `MAX_SUBJECT_CHARS`, or the walk and the purge plan would derive
 * different subject ids from the same row.
 */
export const MAX_METADATA_CHARS = MAX_SUBJECT_CHARS;
/** Characters of a snapshot's basename that reach an attachment reference. */
export const MAX_FILENAME_CHARS = 255;
export const DEFAULT_SETTLE_SECONDS = 300;
export const MAX_PLAN_IDS = 10_000;
export const PLAN_PAGE = 5_000;

const TOP_LEVEL_KEYS = [
  "schema",
  "last_frame_id",
  "last_transcription_id",
  "skipped",
] as const;
const SKIPPED_KEYS = [
  "frames_without_text",
  "frames_bad_timestamp",
  "transcriptions_bad_timestamp",
] as const;

export function initialCursor(afterIds?: {
  frame: number;
  transcription: number;
}): ScreenpipeCursor {
  const frame = afterIds?.frame ?? 0;
  const transcription = afterIds?.transcription ?? 0;
  if (!isCounter(frame) || !isCounter(transcription)) malformedCursor();
  return {
    schema: SCREENPIPE_CURSOR_SCHEMA,
    last_frame_id: frame,
    last_transcription_id: transcription,
    skipped: {
      frames_without_text: 0,
      frames_bad_timestamp: 0,
      transcriptions_bad_timestamp: 0,
    },
  };
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
    !isCounter(parsed["last_transcription_id"])
  ) {
    malformedCursor();
  }
  const skipped = parsed["skipped"];
  if (
    !isPlainObject(skipped) ||
    !hasExactKeys(skipped, SKIPPED_KEYS) ||
    !isCounter(skipped["frames_without_text"]) ||
    !isCounter(skipped["frames_bad_timestamp"]) ||
    !isCounter(skipped["transcriptions_bad_timestamp"])
  ) {
    malformedCursor();
  }
  return {
    schema: SCREENPIPE_CURSOR_SCHEMA,
    last_frame_id: parsed["last_frame_id"],
    last_transcription_id: parsed["last_transcription_id"],
    skipped: {
      frames_without_text: skipped["frames_without_text"],
      frames_bad_timestamp: skipped["frames_bad_timestamp"],
      transcriptions_bad_timestamp: skipped["transcriptions_bad_timestamp"],
    },
  };
}

export function encodeCursor(cursor: ScreenpipeCursor): string {
  const checked = parseCursor(JSON.stringify(cursor));
  return JSON.stringify(checked);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
