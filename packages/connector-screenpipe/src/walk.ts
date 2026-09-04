import type { CaptureEventInput } from "@kizuki/core";
import type { ParsedScreenpipeConfig } from "./config";
import {
  recordSkippedFrame,
  recordSkippedTranscription,
  type ScreenpipeCursor,
} from "./cursor";
import { mapFrame, mapTranscription } from "./map";
import {
  readFrames,
  readTranscriptions,
  type FrameRow,
  type TranscriptionRow,
} from "./read";
import { offsetSeconds, resolveTimestamp } from "./time";

export type StreamKind = "frame" | "transcription";

export interface PreparedEvent {
  stream: StreamKind;
  id: number;
  occurredAt: string;
  event: CaptureEventInput;
}

export function comparePrepared(left: PreparedEvent, right: PreparedEvent): number {
  if (left.occurredAt !== right.occurredAt) {
    return left.occurredAt < right.occurredAt ? -1 : 1;
  }
  if (left.stream !== right.stream) {
    return left.stream < right.stream ? -1 : 1;
  }
  return left.id - right.id;
}

export interface StreamWalker {
  next(): PreparedEvent | null;
  readonly paused: boolean;
  readonly done: boolean;
}

export function createFrameWalker(
  db: Parameters<typeof readFrames>[0],
  cursor: ScreenpipeCursor,
  boundary: string,
  observedAt: string,
  config: ParsedScreenpipeConfig,
): StreamWalker {
  return new RowWalker(
    cursor.last_frame_id,
    cursor.snapshot_frame_max,
    (after, limit, through) => readFrames(db, after, limit, through),
    (row) => prepareFrame(row, cursor, boundary, observedAt, config),
    (id) => {
      cursor.last_frame_id = id;
    },
  );
}

export function createTranscriptionWalker(
  db: Parameters<typeof readTranscriptions>[0],
  cursor: ScreenpipeCursor,
  boundary: string,
  observedAt: string,
  config: ParsedScreenpipeConfig,
): StreamWalker {
  return new RowWalker(
    cursor.last_transcription_id,
    cursor.snapshot_transcription_max,
    (after, limit, through) => readTranscriptions(db, after, limit, through),
    (row) => prepareTranscription(row, cursor, boundary, observedAt, config),
    (id) => {
      cursor.last_transcription_id = id;
    },
  );
}

type PrepareResult<T> =
  | { kind: "emit"; prepared: PreparedEvent }
  | { kind: "skip" }
  | { kind: "pause" };

class RowWalker<T extends { id: number }> implements StreamWalker {
  #buffer: T[] = [];
  #index = 0;
  #after: number;
  paused = false;
  done = false;

  constructor(
    afterId: number,
    private readonly throughId: number,
    private readonly readPage: (after: number, limit: number, through: number) => T[],
    private readonly prepare: (row: T) => PrepareResult<T>,
    private readonly commitId: (id: number) => void,
  ) {
    this.#after = afterId;
    this.done = this.#after >= throughId;
  }

  next(): PreparedEvent | null {
    while (!this.paused && !this.done) {
      if (this.#index >= this.#buffer.length) this.#refill();
      if (this.done) return null;
      const row = this.#buffer[this.#index];
      if (row === undefined) {
        this.done = true;
        return null;
      }
      this.#index += 1;
      const prepared = this.prepare(row);
      switch (prepared.kind) {
        case "emit":
          this.commitId(row.id);
          this.#after = row.id;
          return prepared.prepared;
        case "skip":
          this.commitId(row.id);
          this.#after = row.id;
          continue;
        case "pause":
          this.paused = true;
          return null;
        default: {
          const exhaustive: never = prepared;
          return exhaustive;
        }
      }
    }
    return null;
  }

  #refill(): void {
    if (this.#after >= this.throughId) {
      this.done = true;
      return;
    }
    this.#buffer = this.readPage(this.#after, 64, this.throughId);
    this.#index = 0;
    if (this.#buffer.length === 0) this.done = true;
  }
}

function prepareFrame(
  row: FrameRow,
  cursor: ScreenpipeCursor,
  boundary: string,
  observedAt: string,
  config: ParsedScreenpipeConfig,
): PrepareResult<FrameRow> {
  const resolved = resolveTimestamp(row.timestamp, config.timezone);
  if ("reject" in resolved) {
    if (resolved.reject === "offset_unknown") {
      cursor.skipped.frames_offset_unknown += 1;
    } else {
      cursor.skipped.frames_bad_timestamp += 1;
    }
    recordSkippedFrame(cursor, row.id);
    return { kind: "skip" };
  }
  if (resolved.iso > boundary) return { kind: "pause" };
  if (row.full_text === null || row.full_text.trim().length === 0) {
    cursor.skipped.frames_without_text += 1;
    recordSkippedFrame(cursor, row.id);
    return { kind: "skip" };
  }
  return {
    kind: "emit",
    prepared: {
      stream: "frame",
      id: row.id,
      occurredAt: resolved.iso,
      event: mapFrame(row, observedAt, {
        occurredAt: resolved.iso,
        retainFullUrls: config.retain_full_urls,
      }),
    },
  };
}

function prepareTranscription(
  row: TranscriptionRow,
  cursor: ScreenpipeCursor,
  boundary: string,
  observedAt: string,
  config: ParsedScreenpipeConfig,
): PrepareResult<TranscriptionRow> {
  const resolved = resolveTimestamp(row.timestamp, config.timezone);
  if ("reject" in resolved) {
    if (resolved.reject === "offset_unknown") {
      cursor.skipped.transcriptions_offset_unknown += 1;
    } else {
      cursor.skipped.transcriptions_bad_timestamp += 1;
    }
    recordSkippedTranscription(cursor, row.id);
    return { kind: "skip" };
  }
  const occurredAt = offsetSeconds(resolved.iso, row.start_time);
  if (occurredAt === null) {
    cursor.skipped.transcriptions_bad_offset += 1;
    recordSkippedTranscription(cursor, row.id);
    return { kind: "skip" };
  }
  if (occurredAt > boundary) return { kind: "pause" };
  return {
    kind: "emit",
    prepared: {
      stream: "transcription",
      id: row.id,
      occurredAt,
      event: mapTranscription(row, observedAt, {
        occurredAt: resolved.iso,
        retainFullUrls: config.retain_full_urls,
      }),
    },
  };
}
