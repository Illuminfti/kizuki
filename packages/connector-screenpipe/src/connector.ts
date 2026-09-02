import { Database } from "bun:sqlite";
import type {
  CaptureEventInput,
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import { HealthReport } from "@kizuki/core";
import {
  SCREENPIPE_CONNECTOR_ID,
  parseConfig,
  type ParsedScreenpipeConfig,
  type ScreenpipeConfig,
  type ScreenpipeDeps,
} from "./config";
import {
  BATCH_LIMIT,
  MAX_PAGES_PER_CALL,
  encodeCursor,
  initialCursor,
  parseCursor,
  type ScreenpipeCursor,
  type SkippedCounters,
} from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { FIXTURE_NOW, seedFixtureDatabase } from "./fixture";
import { mapFrame, mapTranscription } from "./map";
import { classifyDatabaseError, openReadOnly } from "./open";
import { planSourceRecords } from "./purge";
import {
  readFrames,
  readTranscriptions,
  seedAfterIds,
} from "./read";
import { assertSchema, inspectSchema } from "./schema";
import { normalizeTimestamp } from "./time";

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: SCREENPIPE_CONNECTOR_ID,
  version: "0.1.0",
  kinds: ["screen_text", "audio_transcription"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: false,
    purge: true,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: true,
  auth_modes: ["none"],
  default_sensitivity: "private",
  sensitivity_floor: "personal",
};

export class ScreenpipeConnector implements Connector {
  readonly #config: ParsedScreenpipeConfig;
  readonly #deps: ScreenpipeDeps;
  #db: Database | null = null;
  #revoked = false;
  #lastSuccessAt: string | undefined;
  #lastSkipped: SkippedCounters = {
    frames_without_text: 0,
    frames_bad_timestamp: 0,
    transcriptions_bad_timestamp: 0,
  };

  constructor(
    config: ScreenpipeConfig,
    deps: Partial<ScreenpipeDeps> = {},
  ) {
    this.#config = parseConfig(config);
    this.#deps = {
      now: deps.now ?? Date.now,
      open: deps.open ?? openReadOnly,
    };
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.#nowIso();
    if (this.#revoked) {
      return new HealthReport({
        state: "disabled",
        checked_at: checkedAt,
        detail: "revoked",
      });
    }
    try {
      const report = inspectSchema(this.#ensureOpen());
      if (!report.ok) {
        return new HealthReport({
          state: "misconfigured",
          checked_at: checkedAt,
          detail: report.detail,
        });
      }
      const badTimestamps =
        this.#lastSkipped.frames_bad_timestamp +
        this.#lastSkipped.transcriptions_bad_timestamp;
      const skipped =
        this.#lastSkipped.frames_without_text > 0 || badTimestamps > 0
          ? `; skipped ${this.#lastSkipped.frames_without_text} without text, ${badTimestamps} unparsable timestamps`
          : "";
      return new HealthReport({
        state: "ok",
        checked_at: checkedAt,
        detail: `${report.detail}${skipped}`,
        ...(this.#lastSuccessAt === undefined
          ? {}
          : { last_success_at: this.#lastSuccessAt }),
      });
    } catch (error) {
      const mapped = classifyDatabaseError(error, this.#config.path);
      return new HealthReport({
        state: mapped.code === "locked" ? "unreachable" : "misconfigured",
        checked_at: checkedAt,
        detail:
          mapped.code === "locked"
            ? "screenpipe database is locked; retry"
            : mapped.message,
      });
    }
  }

  async connect(_resolve: SecretResolver): Promise<void> {
    this.#withDatabase((db) => {
      assertSchema(db);
    });
  }

  backfill(cursor: Cursor | null): Promise<SyncBatch> {
    return this.#advance(cursor);
  }

  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.#advance(cursor);
  }

  async revoke(): Promise<void> {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#db?.close();
    this.#db = null;
  }

  async purgeSource(subject_id: string): Promise<PurgePlan> {
    return this.#withDatabase((db) => {
      assertSchema(db);
      return {
        subject_id,
        source_record_ids: [],
        unreachable_source_record_ids: planSourceRecords(
          db,
          subject_id,
        ),
      };
    });
  }

  async fixture(): Promise<CaptureEventInput[]> {
    this.#assertActive();
    const memory = new Database(":memory:", { safeIntegers: true });
    seedFixtureDatabase(memory);
    const connector = new ScreenpipeConnector(
      { path: ":memory:", settle_seconds: 0 },
      {
        now: () => Date.parse(FIXTURE_NOW),
        open: () => memory,
      },
    );
    const events: CaptureEventInput[] = [];
    let cursor: Cursor | null = null;
    try {
      while (true) {
        const batch = await connector.backfill(cursor);
        events.push(...batch.events);
        cursor = batch.cursor;
        if (batch.events.length === 0) break;
      }
      return events;
    } finally {
      await connector.revoke();
    }
  }

  async #advance(cursor: Cursor | null): Promise<SyncBatch> {
    return this.#withDatabase((db) => {
      assertSchema(db);
      const now = this.#deps.now();
      const observedAt = new Date(now).toISOString();
      const settleMs = this.#config.settle_seconds * 1_000;
      const boundary = new Date(now - settleMs).toISOString();
      // screenpipe stamps rows from the capture machine's clock, so a bad row
      // or a clock step can date a row past `now`. Such a row is not waiting
      // for the OCR update the settle window exists for, and holding it would
      // park this walk on its id for as long as the date says.
      const horizon = new Date(now + settleMs).toISOString();
      const current =
        cursor === null
          ? initialCursor(
              this.#config.since === null
                ? undefined
                : seedAfterIds(db, this.#config.since, horizon),
            )
          : parseCursor(cursor);
      const before = { ...current.skipped };
      const walk: Walk = {
        observedAt,
        settling: (timestamp) => timestamp > boundary && timestamp <= horizon,
      };
      const events: CaptureEventInput[] = [];

      // An empty batch is the drain signal every caller uses, so the walk
      // keeps reading pages until it has an event, both tables are exhausted
      // for this cursor, or the settle window stops it. A page of frames
      // without text is ordinary screenpipe output, not the end of the data.
      // MAX_PAGES_PER_CALL bounds that retry, per table: a run of skipped rows
      // longer than the bound returns an advanced cursor and no events, and
      // the next call resumes behind it rather than scanning the table in one
      // go. Spending the bound on one table never hides the other.
      let framesDone = false;
      let transcriptionsDone = false;
      let framePages = 0;
      let transcriptionPages = 0;
      while (events.length < BATCH_LIMIT && !(framesDone && transcriptionsDone)) {
        if (!framesDone && framePages < MAX_PAGES_PER_CALL) {
          framePages += 1;
          framesDone = walkFrames(db, current, events, walk);
          continue;
        }
        if (transcriptionsDone || transcriptionPages >= MAX_PAGES_PER_CALL) {
          break;
        }
        transcriptionPages += 1;
        transcriptionsDone = walkTranscriptions(db, current, events, walk);
      }

      this.#lastSuccessAt = observedAt;
      this.#lastSkipped = skipDelta(before, current);
      return { events, cursor: encodeCursor(current) };
    });
  }

  #ensureOpen(): Database {
    this.#assertActive();
    if (this.#db === null) this.#db = this.#deps.open(this.#config.path);
    return this.#db;
  }

  #assertActive(): void {
    if (this.#revoked) {
      throw new ScreenpipeConnectorError(
        "closed",
        "kizuki.screenpipe: connector was revoked; build a new instance",
      );
    }
  }

  #withDatabase<T>(operation: (db: Database) => T): T {
    try {
      return operation(this.#ensureOpen());
    } catch (error) {
      throw classifyDatabaseError(error, this.#config.path);
    }
  }

  #nowIso(): string {
    return new Date(this.#deps.now()).toISOString();
  }
}

export function createScreenpipeConnector(
  config: ScreenpipeConfig,
): ScreenpipeConnector {
  return new ScreenpipeConnector(config);
}

function skipDelta(
  before: SkippedCounters,
  current: ScreenpipeCursor,
): SkippedCounters {
  return {
    frames_without_text:
      current.skipped.frames_without_text - before.frames_without_text,
    frames_bad_timestamp:
      current.skipped.frames_bad_timestamp - before.frames_bad_timestamp,
    transcriptions_bad_timestamp:
      current.skipped.transcriptions_bad_timestamp -
      before.transcriptions_bad_timestamp,
  };
}

interface Walk {
  observedAt: string;
  settling: (timestamp: string) => boolean;
}

/**
 * Returns true when the frame walk is finished for this batch. Every page is a
 * full one: sizing it by the remaining event budget collapses to one statement
 * per row as soon as a batch is nearly full, and a run of skipped rows behind
 * it then costs one round trip each.
 */
function walkFrames(
  db: Database,
  cursor: ScreenpipeCursor,
  events: CaptureEventInput[],
  walk: Walk,
): boolean {
  const rows = readFrames(db, cursor.last_frame_id, BATCH_LIMIT);
  for (const row of rows) {
    // The cursor stays short of a row the batch has no room for, so the next
    // call reads it instead.
    if (events.length >= BATCH_LIMIT) return true;
    const timestamp = normalizeTimestamp(row.timestamp);
    if (timestamp === null) {
      cursor.skipped.frames_bad_timestamp += 1;
      cursor.last_frame_id = row.id;
      continue;
    }
    // A settling row is left for the next call so late OCR text is not lost.
    if (walk.settling(timestamp)) return true;
    if (row.full_text === null || row.full_text.trim().length === 0) {
      cursor.skipped.frames_without_text += 1;
      cursor.last_frame_id = row.id;
      continue;
    }
    events.push(mapFrame(row, walk.observedAt));
    cursor.last_frame_id = row.id;
  }
  return rows.length < BATCH_LIMIT;
}

/** Returns true when the transcription walk is finished for this batch. */
function walkTranscriptions(
  db: Database,
  cursor: ScreenpipeCursor,
  events: CaptureEventInput[],
  walk: Walk,
): boolean {
  const rows = readTranscriptions(db, cursor.last_transcription_id, BATCH_LIMIT);
  for (const row of rows) {
    if (events.length >= BATCH_LIMIT) return true;
    const timestamp = normalizeTimestamp(row.timestamp);
    if (timestamp === null) {
      cursor.skipped.transcriptions_bad_timestamp += 1;
      cursor.last_transcription_id = row.id;
      continue;
    }
    if (walk.settling(timestamp)) return true;
    events.push(mapTranscription(row, walk.observedAt));
    cursor.last_transcription_id = row.id;
  }
  return rows.length < BATCH_LIMIT;
}
