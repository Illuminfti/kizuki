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
  SKIP_DEGRADE_THRESHOLD,
  encodeCursor,
  emptySkipped,
  initialCursor,
  parseCursor,
  parseSkipTotal,
  type ScreenpipeCursor,
  type SkippedCounters,
} from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { FIXTURE_NOW, seedFixtureDatabase } from "./fixture";
import {
  assertCompatibleIdentity,
  inspectIdentity,
} from "./identity";
import { classifyDatabaseError, openReadOnly } from "./open";
import { planSourceRecords } from "./purge";
import { seedAfterIds } from "./read";
import { assertSchema, inspectSchema } from "./schema";
import {
  comparePrepared,
  createFrameWalker,
  createTranscriptionWalker,
} from "./walk";

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: SCREENPIPE_CONNECTOR_ID,
  version: "0.1.0",
  kinds: ["screen_text", "audio_transcription"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: false,
    purge: false,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: true,
  default_sensitivity: "private",
  sensitivity_floor: "private",
  auth_modes: ["none"],
};

export class ScreenpipeConnector implements Connector {
  readonly #config: ParsedScreenpipeConfig;
  readonly #deps: ScreenpipeDeps;
  #db: Database | null = null;
  #revoked = false;
  #lastSuccessAt: string | undefined;
  #lastSkipped: SkippedCounters = emptySkipped();
  #totalSkipped: SkippedCounters = emptySkipped();
  #oldestSkippedFrameId = 0;
  #oldestSkippedTranscriptionId = 0;

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
      const parseErrors = parseSkipTotal(this.#totalSkipped);
      const skipped = formatSkipped(this.#totalSkipped);
      const oldest = formatOldestSkipped(
        this.#oldestSkippedFrameId,
        this.#oldestSkippedTranscriptionId,
      );
      const suffix =
        parseErrors > 0 || this.#totalSkipped.frames_without_text > 0
          ? `; ${skipped}${oldest}`
          : "";
      return new HealthReport({
        state:
          parseErrors >= SKIP_DEGRADE_THRESHOLD ? "degraded" : "ok",
        checked_at: checkedAt,
        detail: `${report.detail}${suffix}`,
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
    return this.#advance(cursor, "backfill");
  }

  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.#advance(cursor, "sync");
  }

  async revoke(): Promise<void> {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#db?.close();
    this.#db = null;
  }

  async purgeSource(_subject_id: string): Promise<PurgePlan> {
    this.#assertActive();
    throw new ScreenpipeConnectorError(
      "not_supported",
      "kizuki.screenpipe: source-side deletion is not supported; the database is opened read-only. Use ledger purge for imported evidence. planUnreachableSourceRecords() lists matching source ids without deleting them.",
    );
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
        if (batch.cursor === null) break;
        const parsed = parseCursor(batch.cursor);
        if (parsed.phase !== "continue") break;
        cursor = batch.cursor;
      }
      return events;
    } finally {
      await connector.revoke();
    }
  }

  async #advance(
    cursor: Cursor | null,
    mode: "backfill" | "sync",
  ): Promise<SyncBatch> {
    return this.#withDatabase((db) => {
      assertSchema(db);
      const identity = inspectIdentity(db, this.#config.path);
      const current =
        cursor === null
          ? initialCursor(
              identity,
              this.#config.since === null
                ? undefined
                : seedAfterIds(db, this.#config.since, this.#config.timezone),
            )
          : parseCursor(cursor);
      if (cursor !== null) {
        assertCompatibleIdentity(
          current.db_path,
          current.db_fingerprint,
          current.high_water_frame,
          current.high_water_transcription,
          current.last_frame_id,
          current.last_transcription_id,
          identity,
        );
      }
      if (mode === "sync") {
        current.snapshot_frame_max = Math.max(
          current.snapshot_frame_max,
          identity.max_frame_id,
        );
        current.snapshot_transcription_max = Math.max(
          current.snapshot_transcription_max,
          identity.max_transcription_id,
        );
        if (current.phase === "exhausted") current.phase = "continue";
      }
      current.high_water_frame = Math.max(
        current.high_water_frame,
        identity.max_frame_id,
      );
      current.high_water_transcription = Math.max(
        current.high_water_transcription,
        identity.max_transcription_id,
      );

      const before = { ...current.skipped };
      const now = this.#deps.now();
      const observedAt = new Date(now).toISOString();
      const boundary = new Date(
        now - this.#config.settle_seconds * 1_000,
      ).toISOString();
      const events: CaptureEventInput[] = [];
      const frames = createFrameWalker(
        db,
        current,
        boundary,
        observedAt,
        this.#config,
      );
      const transcriptions = createTranscriptionWalker(
        db,
        current,
        boundary,
        observedAt,
        this.#config,
      );
      let nextFrame = frames.next();
      let nextAudio = transcriptions.next();
      while (events.length < BATCH_LIMIT) {
        const frame = nextFrame;
        const audio = nextAudio;
        if (frame === null && audio === null) break;
        if (frame === null) {
          if (audio === null) break;
          events.push(audio.event);
          if (events.length === BATCH_LIMIT) break;
          nextAudio = transcriptions.next();
          continue;
        }
        if (audio === null) {
          events.push(frame.event);
          if (events.length === BATCH_LIMIT) break;
          nextFrame = frames.next();
          continue;
        }
        if (comparePrepared(frame, audio) <= 0) {
          events.push(frame.event);
          if (events.length === BATCH_LIMIT) break;
          nextFrame = frames.next();
        } else {
          events.push(audio.event);
          if (events.length === BATCH_LIMIT) break;
          nextAudio = transcriptions.next();
        }
      }

      current.phase = batchPhase(
        events.length,
        frames.paused || transcriptions.paused,
        frames.done && transcriptions.done,
      );
      this.#lastSuccessAt = observedAt;
      this.#lastSkipped = skipDelta(before, current);
      this.#totalSkipped = { ...current.skipped };
      this.#oldestSkippedFrameId = current.oldest_skipped_frame_id;
      this.#oldestSkippedTranscriptionId =
        current.oldest_skipped_transcription_id;
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

export function planUnreachableSourceRecords(
  db: Database,
  subjectId: string,
  now?: () => number,
): string[] {
  return planSourceRecords(db, subjectId, now).ids;
}

function batchPhase(
  eventCount: number,
  paused: boolean,
  bothDone: boolean,
): ScreenpipeCursor["phase"] {
  if (eventCount === BATCH_LIMIT) return "continue";
  if (paused && !bothDone) return "caught_up";
  if (bothDone) return "exhausted";
  if (paused) return "caught_up";
  return "continue";
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
    frames_offset_unknown:
      current.skipped.frames_offset_unknown - before.frames_offset_unknown,
    transcriptions_bad_timestamp:
      current.skipped.transcriptions_bad_timestamp -
      before.transcriptions_bad_timestamp,
    transcriptions_bad_offset:
      current.skipped.transcriptions_bad_offset -
      before.transcriptions_bad_offset,
    transcriptions_offset_unknown:
      current.skipped.transcriptions_offset_unknown -
      before.transcriptions_offset_unknown,
  };
}

function formatSkipped(skipped: SkippedCounters): string {
  return (
    `skipped frames_without_text=${skipped.frames_without_text} ` +
    `frames_bad_timestamp=${skipped.frames_bad_timestamp} ` +
    `frames_offset_unknown=${skipped.frames_offset_unknown} ` +
    `transcriptions_bad_timestamp=${skipped.transcriptions_bad_timestamp} ` +
    `transcriptions_bad_offset=${skipped.transcriptions_bad_offset} ` +
    `transcriptions_offset_unknown=${skipped.transcriptions_offset_unknown}`
  );
}

function formatOldestSkipped(frameId: number, transcriptionId: number): string {
  const parts: string[] = [];
  if (frameId > 0) parts.push(`oldest_skipped_frame=${frameId}`);
  if (transcriptionId > 0) {
    parts.push(`oldest_skipped_transcription=${transcriptionId}`);
  }
  return parts.length === 0 ? "" : `; ${parts.join(" ")}`;
}
