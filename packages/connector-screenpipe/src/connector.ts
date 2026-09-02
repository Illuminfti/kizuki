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
  encodeCursor,
  initialCursor,
  parseCursor,
  type ScreenpipeCursor,
  type SkippedCounters,
} from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { FIXTURE_NOW, seedFixtureDatabase } from "./fixture";
import { classifyDatabaseError, openReadOnly } from "./open";
import { planSourceRecords } from "./purge";
import { seedAfterIds } from "./read";
import { assertSchema, inspectSchema } from "./schema";
import { collectEvents, type WalkWindow } from "./walk";

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
  #lastStall: string | null = null;
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
      // A stalled walk cannot pass the row that stopped it, so the checkpoint
      // will not move again on its own. Reporting `ok` would leave `doctor`
      // green over a source that stopped taking anything in.
      if (this.#lastStall !== null) {
        return new HealthReport({
          state: "misconfigured",
          checked_at: checkedAt,
          detail: this.#lastStall,
          ...(this.#lastSuccessAt === undefined
            ? {}
            : { last_success_at: this.#lastSuccessAt }),
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
          this.#config.since,
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
      const since = this.#config.since;
      const current =
        cursor === null
          ? initialCursor(
              since === null ? undefined : seedAfterIds(db, since),
            )
          : parseCursor(cursor);
      const before = { ...current.skipped };
      const walk: WalkWindow = {
        observedAt,
        settling: (timestamp) => timestamp > boundary && timestamp <= horizon,
        beforeSince: (timestamp) => since !== null && timestamp < since,
      };
      const batch = collectEvents(db, current, walk);

      this.#lastSuccessAt = observedAt;
      this.#lastStall = batch.stalled;
      this.#lastSkipped = skipDelta(before, current);
      return { events: batch.events, cursor: encodeCursor(current) };
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
