import type { Database } from "bun:sqlite";
import type { CaptureEventInput } from "@kizuki/core";
import type { ParsedScreenpipeConfig } from "./config";
import { type ScreenpipeCursor } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
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
  peek(): PreparedEvent | null;
  take(): void;
  readonly paused: boolean;
  readonly done: boolean;
}

export function createFrameWalker(
  db: Database,
  cursor: ScreenpipeCursor,
  boundary: string,
  observedAt: string,
  config: ParsedScreenpipeConfig,
): StreamWalker {
  return new RowWalker(
    cursor.last_frame_id,
    cursor.snapshot_frame_max,
    (after, limit, through) => readFrames(db, after, limit, through),
    (row) => prepareFrame(row, boundary, observedAt, config),
    (id) => {
      cursor.last_frame_id = id;
    },
  );
}

export function createTranscriptionWalker(
  db: Database,
  cursor: ScreenpipeCursor,
  boundary: string,
  observedAt: string,
  config: ParsedScreenpipeConfig,
): StreamWalker {
  return new RowWalker(
    cursor.last_transcription_id,
    cursor.snapshot_transcription_max,
    (after, limit, through) => readTranscriptions(db, after, limit, through),
    (row) => prepareTranscription(row, boundary, observedAt, config),
    (id) => {
      cursor.last_transcription_id = id;
    },
  );
}

type PrepareResult =
  | { kind: "emit"; prepared: PreparedEvent }
  | { kind: "pause" };

class RowWalker<T extends { id: number }> implements StreamWalker {
  #buffer: T[] = [];
  #index = 0;
  #after: number;
  #pending: PreparedEvent | null | undefined;
  paused = false;
  done = false;

  constructor(
    afterId: number,
    private readonly throughId: number,
    private readonly readPage: (after: number, limit: number, through: number) => T[],
    private readonly prepare: (row: T) => PrepareResult,
    private readonly commitId: (id: number) => void,
  ) {
    this.#after = afterId;
    this.done = this.#after >= throughId;
  }

  peek(): PreparedEvent | null {
    if (this.#pending !== undefined) return this.#pending;
    this.#pending = this.#pull();
    return this.#pending;
  }

  take(): void {
    const pending = this.peek();
    if (pending === null) return;
    this.commitId(pending.id);
    this.#after = pending.id;
    this.#pending = undefined;
  }

  #pull(): PreparedEvent | null {
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
          return prepared.prepared;
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
  boundary: string,
  observedAt: string,
  config: ParsedScreenpipeConfig,
): PrepareResult {
  const resolved = resolveTimestamp(row.timestamp, config.timezone);
  if ("reject" in resolved) {
    throw malformedRow("frame", row.id, "timestamp");
  }
  if (resolved.iso > boundary) return { kind: "pause" };
  if (row.full_text === null || row.full_text.trim().length === 0) {
    throw malformedRow("frame", row.id, "text");
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
  boundary: string,
  observedAt: string,
  config: ParsedScreenpipeConfig,
): PrepareResult {
  const resolved = resolveTimestamp(row.timestamp, config.timezone);
  if ("reject" in resolved) {
    throw malformedRow("transcription", row.id, "timestamp");
  }
  const occurredAt = offsetSeconds(resolved.iso, row.start_time);
  if (occurredAt === null) {
    throw malformedRow("transcription", row.id, "offset");
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

function malformedRow(
  kind: StreamKind,
  id: number,
  field: string,
): ScreenpipeConnectorError {
  return new ScreenpipeConnectorError(
    "parse_error",
    `kizuki.screenpipe: malformed ${kind}:${id} ${field}; checkpoint was not advanced`,
  );
}
