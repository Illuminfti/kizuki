import type { Database } from "bun:sqlite";
import type { CaptureEventInput } from "@kizuki/core";
import {
  BATCH_LIMIT,
  TRANSCRIPTION_RESERVE,
  type ScreenpipeCursor,
} from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { mapFrame, mapTranscription } from "./map";
import {
  type FrameRow,
  type TranscriptionRow,
  mapFrameRow,
  mapTranscriptionRow,
  readFramePage,
  readTranscriptionPage,
} from "./read";
import { normalizeTimestamp } from "./time";

export interface WalkWindow {
  observedAt: string;
  settling: (timestamp: string) => boolean;
  /**
   * `since` is enforced here rather than by the cursor seed alone. A row's id
   * does not follow its timestamp — screenpipe stamps a transcription when it
   * finishes transcribing, and a clock step reorders frames — so a single row
   * dated inside the window can seed the walk at the head of the table and
   * every older row behind it would be read.
   */
  beforeSince: (timestamp: string) => boolean;
}

/**
 * Why one table's walk ended. Only `budget` leaves rows behind that this call
 * could have read; the others mean the table has nothing more to give now.
 */
type Stop = "drained" | "settling" | "budget" | "stalled";

export interface Batch {
  events: CaptureEventInput[];
  /**
   * The column whose value stopped a walk short of a row it cannot read, so
   * `health()` can say the source is stuck instead of reporting `ok` over a
   * checkpoint that will never move again. Null when nothing stopped one.
   */
  stalled: string | null;
}

/**
 * Fills one batch from both tables, advancing the cursor past every row it
 * consumes.
 *
 * Frames are read first, as the spec orders them, but may not take the last
 * `TRANSCRIPTION_RESERVE` places while the transcription table is unread. A
 * recording machine writes frames continuously and transcriptions in bursts,
 * so a batch frames alone can fill would leave `audio_transcription` — a kind
 * this connector declares — unread for as long as the screen keeps changing.
 * Once the other table is caught up the reserve goes back to frames, so a
 * database with no audio still fills whole batches with them.
 */
export function collectEvents(
  db: Database,
  cursor: ScreenpipeCursor,
  window: WalkWindow,
): Batch {
  const batch: Batch = { events: [], stalled: null };
  const frames = walkFrames(
    db,
    cursor,
    batch,
    window,
    BATCH_LIMIT - TRANSCRIPTION_RESERVE,
  );
  const transcriptions = walkTranscriptions(
    db,
    cursor,
    batch,
    window,
    BATCH_LIMIT,
  );
  if (frames === "budget" && transcriptions !== "budget") {
    walkFrames(db, cursor, batch, window, BATCH_LIMIT);
  }
  return batch;
}

/**
 * Every page is a full one: sizing it by the remaining event budget collapses
 * to one statement per row as soon as a batch is nearly full, and a run of
 * skipped rows behind it then costs one round trip each.
 */
function walkFrames(
  db: Database,
  cursor: ScreenpipeCursor,
  batch: Batch,
  window: WalkWindow,
  budget: number,
): Stop {
  const events = batch.events;
  while (events.length < budget) {
    const rows = readFramePage(db, cursor.last_frame_id, BATCH_LIMIT);
    for (const raw of rows) {
      // The cursor stays short of a row the batch has no room for, so the next
      // call reads it instead.
      if (events.length >= budget) return "budget";
      let row: FrameRow;
      try {
        row = mapFrameRow(raw);
      } catch (error) {
        batch.stalled = stallText(error);
        return "stalled";
      }
      const timestamp = normalizeTimestamp(row.timestamp);
      if (timestamp === null) {
        cursor.skipped.frames_bad_timestamp += 1;
        cursor.last_frame_id = row.id;
        continue;
      }
      // A row the owner asked to skip is dropped before the settle window,
      // which exists to give late OCR a chance at a row that would be emitted.
      // It is not counted: the cursor's counters record rows dropped despite
      // being in scope, and configuration is not a skip of that kind.
      if (window.beforeSince(timestamp)) {
        cursor.last_frame_id = row.id;
        continue;
      }
      // A settling row is left for the next call so late OCR text is not lost.
      if (window.settling(timestamp)) return "settling";
      if (row.full_text === null || row.full_text.trim().length === 0) {
        cursor.skipped.frames_without_text += 1;
        cursor.last_frame_id = row.id;
        continue;
      }
      events.push(mapFrame(row, window.observedAt));
      cursor.last_frame_id = row.id;
    }
    if (rows.length < BATCH_LIMIT) return "drained";
  }
  return "budget";
}

function walkTranscriptions(
  db: Database,
  cursor: ScreenpipeCursor,
  batch: Batch,
  window: WalkWindow,
  budget: number,
): Stop {
  const events = batch.events;
  while (events.length < budget) {
    const rows = readTranscriptionPage(
      db,
      cursor.last_transcription_id,
      BATCH_LIMIT,
    );
    for (const raw of rows) {
      if (events.length >= budget) return "budget";
      let row: TranscriptionRow;
      try {
        row = mapTranscriptionRow(raw);
      } catch (error) {
        batch.stalled = stallText(error);
        return "stalled";
      }
      const timestamp = normalizeTimestamp(row.timestamp);
      if (timestamp === null) {
        cursor.skipped.transcriptions_bad_timestamp += 1;
        cursor.last_transcription_id = row.id;
        continue;
      }
      if (window.beforeSince(timestamp)) {
        cursor.last_transcription_id = row.id;
        continue;
      }
      if (window.settling(timestamp)) return "settling";
      events.push(mapTranscription(row, window.observedAt));
      cursor.last_transcription_id = row.id;
    }
    if (rows.length < BATCH_LIMIT) return "drained";
  }
  return "budget";
}

/**
 * A row this connector cannot read stops its table where it stands, so the
 * rows already read keep their place in the checkpoint. Anything that is not a
 * row-level parse failure is a fault of this package and still throws.
 */
function stallText(error: unknown): string {
  if (
    error instanceof ScreenpipeConnectorError &&
    error.code === "parse_error"
  ) {
    return error.message;
  }
  throw error;
}
