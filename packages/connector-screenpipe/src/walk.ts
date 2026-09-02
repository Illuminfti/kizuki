import type { Database } from "bun:sqlite";
import type { CaptureEventInput } from "@kizuki/core";
import {
  BATCH_LIMIT,
  TRANSCRIPTION_RESERVE,
  type ScreenpipeCursor,
} from "./cursor";
import { mapFrame, mapTranscription } from "./map";
import { readFrames, readTranscriptions } from "./read";
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
 * could have read; the other two mean the table has nothing more to give right
 * now.
 */
type Stop = "drained" | "settling" | "budget";

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
): CaptureEventInput[] {
  const events: CaptureEventInput[] = [];
  const frames = walkFrames(
    db,
    cursor,
    events,
    window,
    BATCH_LIMIT - TRANSCRIPTION_RESERVE,
  );
  const transcriptions = walkTranscriptions(
    db,
    cursor,
    events,
    window,
    BATCH_LIMIT,
  );
  if (frames === "budget" && transcriptions !== "budget") {
    walkFrames(db, cursor, events, window, BATCH_LIMIT);
  }
  return events;
}

/**
 * Every page is a full one: sizing it by the remaining event budget collapses
 * to one statement per row as soon as a batch is nearly full, and a run of
 * skipped rows behind it then costs one round trip each.
 */
function walkFrames(
  db: Database,
  cursor: ScreenpipeCursor,
  events: CaptureEventInput[],
  window: WalkWindow,
  budget: number,
): Stop {
  while (events.length < budget) {
    const rows = readFrames(db, cursor.last_frame_id, BATCH_LIMIT);
    for (const row of rows) {
      // The cursor stays short of a row the batch has no room for, so the next
      // call reads it instead.
      if (events.length >= budget) return "budget";
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
  events: CaptureEventInput[],
  window: WalkWindow,
  budget: number,
): Stop {
  while (events.length < budget) {
    const rows = readTranscriptions(
      db,
      cursor.last_transcription_id,
      BATCH_LIMIT,
    );
    for (const row of rows) {
      if (events.length >= budget) return "budget";
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
