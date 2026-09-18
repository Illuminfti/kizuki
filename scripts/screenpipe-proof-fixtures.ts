/**
 * Synthetic stopped-screenpipe databases for the local-source connector proof.
 *
 * The provider's schema is not re-implemented here: the package's own testkit
 * owns that contract. What this module owns is the evidence — low-entropy rows
 * an owner could plausibly have captured, plus the malformed and below-floor
 * shapes the connector must refuse.
 */
import { Database } from "bun:sqlite";
import { FIXTURE_DDL, FIXTURE_MIGRATIONS } from "../packages/connector-screenpipe/src/testkit";

export const SCREENPIPE_CONNECTOR_ID = "kizuki.screenpipe";
/** Distinct, meaningless words. Each proves one stored event reached the ledger. */
export const SCREENPIPE_SENTINEL = "screenpipepetrel";
export const SCREENPIPE_SITE_SENTINEL = "screenpipeavocet";
export const SCREENPIPE_AUDIO_SENTINEL = "screenpipegannet";
/**
 * A credential-shaped path segment: sixteen or more `[A-Za-z0-9_-]` characters,
 * the shape the connector's documented URL redaction replaces with `[redacted]`.
 * It is a fixed synthetic literal with no entropy and unlocks nothing.
 */
export const SCREENPIPE_CREDENTIAL_SEGMENT = "aaaabbbbccccdddd";
export const SCREENPIPE_REDACTION_MARKER = "[redacted]";
export const SCREENPIPE_SITE_HOST = "notes.example.test";
export const SCREENPIPE_SOURCE_URL =
  `https://${SCREENPIPE_SITE_HOST}/s/${SCREENPIPE_CREDENTIAL_SEGMENT}?session=${SCREENPIPE_CREDENTIAL_SEGMENT}`;

/** Every settled row this fixture holds becomes exactly one private event. */
export const SCREENPIPE_EXPECTED = {
  backfill_stored: 3,
  backfill_duplicates: 0,
  /** Both snapshot watermarks are consumed, so a repeat backfill reads nothing. */
  repeat_stored: 0,
  repeat_duplicates: 0,
  /** An incremental sweep re-presents the same settled rows once; the
   * append-only ledger recognises every one of them and stores nothing. */
  sync_stored: 0,
  sync_duplicates: 3,
  /** One capture note per emitted row, plus the app, site and speaker subjects. */
  proposals_created: 8,
  query_hits: 1,
} as const;

export type ScreenpipeFixtureShape = "valid" | "below-floor" | "malformed";

const SENTENCE = (word: string) => `Synthetic ${word} evidence stays on the owner's disk.`;

export interface ScreenpipeFixtureRow {
  shape: ScreenpipeFixtureShape;
  migrations: readonly number[];
  frames: number;
  transcriptions: number;
}

export function screenpipeFixtureShapes(): ScreenpipeFixtureRow[] {
  return [
    { shape: "valid", migrations: FIXTURE_MIGRATIONS, frames: 2, transcriptions: 1 },
    { shape: "below-floor", migrations: [20240703111257], frames: 0, transcriptions: 0 },
    { shape: "malformed", migrations: FIXTURE_MIGRATIONS, frames: 0, transcriptions: 0 },
  ];
}

/**
 * Build one synthetic database file. `valid` is a stopped screenpipe at the
 * verified migration range; `below-floor` applies only a migration older than
 * the supported floor; `malformed` has the migration table but no capture
 * tables at all, so health fails before any row can be read.
 */
export function writeScreenpipeFixture(path: string, shape: ScreenpipeFixtureShape): void {
  const db = new Database(path, { create: true, safeIntegers: true });
  try {
    db.transaction(() => {
      if (shape === "malformed") {
        db.exec(`CREATE TABLE _sqlx_migrations (
  version BIGINT PRIMARY KEY,
  description TEXT NOT NULL,
  installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success BOOLEAN NOT NULL,
  checksum BLOB NOT NULL,
  execution_time BIGINT NOT NULL
);`);
      } else {
        db.exec(FIXTURE_DDL);
      }
      const insertMigration = db.query(
        `INSERT INTO _sqlx_migrations (version, description, installed_on, success, checksum, execution_time)
         VALUES (?, ?, ?, 1, X'', 0)`,
      );
      const row = screenpipeFixtureShapes().find(item => item.shape === shape)!;
      for (const version of row.migrations) {
        insertMigration.run(version, `synthetic migration ${version}`, "2026-01-09T00:00:00.000Z");
      }
      if (shape === "valid") seedValidRows(db);
    }).immediate();
  } finally {
    db.close();
  }
}

function seedValidRows(db: Database): void {
  const insertFrame = db.query(
    `INSERT INTO frames
       (id, video_chunk_id, offset_index, timestamp, app_name, window_name, browser_url,
        device_name, focused, full_text, text_source, capture_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertFrame.run(
    1, 1, 0, "2026-01-05T09:00:00Z", "Synthetic Notes", "Local notes", null,
    "Synthetic Display", 1, SENTENCE(SCREENPIPE_SENTINEL), "accessibility", "interval",
  );
  insertFrame.run(
    2, 1, 1, "2026-01-05T09:01:00Z", "Synthetic Browser", "Saved article", SCREENPIPE_SOURCE_URL,
    "Synthetic Display", 1, SENTENCE(SCREENPIPE_SITE_SENTINEL), "ocr", "interval",
  );
  db.query("INSERT INTO speakers (id, name) VALUES (?, ?)").run(1, "Synthetic Speaker");
  db.query(
    `INSERT INTO audio_chunks (id, file_path, timestamp, transcription_status)
     VALUES (?, ?, ?, 'transcribed')`,
  ).run(1, "/synthetic/screenpipe/2026-01-06_10-00-00-mic.mp4", "2026-01-06T10:00:00Z");
  db.query(
    `INSERT INTO audio_transcriptions
       (id, audio_chunk_id, offset_index, timestamp, transcription, device, is_input_device,
        speaker_id, transcription_engine, start_time, end_time, text_length)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    1, 1, 0, "2026-01-06T10:00:00Z", SENTENCE(SCREENPIPE_AUDIO_SENTINEL),
    "Synthetic Microphone (input)", 1, 1, "whisper", 0, 4,
    SENTENCE(SCREENPIPE_AUDIO_SENTINEL).length,
  );
}
