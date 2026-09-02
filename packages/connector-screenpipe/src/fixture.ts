import type { Database } from "bun:sqlite";

export const FIXTURE_NOW = "2026-01-09T00:00:00.000Z";

export const FIXTURE_MIGRATIONS: readonly number[] = [
  20240703111257, 20260220000000, 20260312000000, 20260613000001,
  20260613130000, 20260828143000,
];

export const FIXTURE_DDL = `
CREATE TABLE _sqlx_migrations (
  version BIGINT PRIMARY KEY,
  description TEXT NOT NULL,
  installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success BOOLEAN NOT NULL,
  checksum BLOB NOT NULL,
  execution_time BIGINT NOT NULL
);

CREATE TABLE frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_chunk_id INTEGER DEFAULT NULL,
  offset_index INTEGER NOT NULL DEFAULT 0,
  timestamp TIMESTAMP NOT NULL,
  name TEXT,
  app_name TEXT DEFAULT NULL,
  window_name TEXT DEFAULT NULL,
  focused BOOLEAN DEFAULT NULL,
  browser_url TEXT DEFAULT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  sync_id TEXT,
  machine_id TEXT,
  synced_at DATETIME,
  snapshot_path TEXT DEFAULT NULL,
  accessibility_text TEXT DEFAULT NULL,
  accessibility_tree_json TEXT DEFAULT NULL,
  content_hash INTEGER DEFAULT NULL,
  simhash INTEGER DEFAULT NULL,
  capture_trigger TEXT DEFAULT NULL,
  text_source TEXT DEFAULT NULL,
  cloud_blob_id TEXT DEFAULT NULL,
  elements_ref_frame_id INTEGER DEFAULT NULL,
  full_text TEXT DEFAULT NULL,
  document_path TEXT DEFAULT NULL,
  accessibility_redacted_at INTEGER,
  image_redacted_at INTEGER,
  full_text_redacted_at INTEGER,
  text_json TEXT DEFAULT NULL,
  accessibility_tree_redacted_at INTEGER,
  window_name_redacted_at INTEGER,
  browser_url_redacted_at INTEGER,
  text_json_redacted_at INTEGER,
  semantic_run_id INTEGER
);

CREATE TABLE audio_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  timestamp TIMESTAMP,
  sync_id TEXT,
  machine_id TEXT,
  synced_at DATETIME,
  evicted_at TIMESTAMP DEFAULT NULL,
  transcription_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (transcription_status IN ('pending', 'transcribed', 'silent', 'failed')),
  transcription_attempts INTEGER NOT NULL DEFAULT 0,
  last_transcription_attempt_at TIMESTAMP,
  transcription_failure_reason TEXT
);

CREATE TABLE speakers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  metadata JSON,
  hallucination BOOLEAN DEFAULT FALSE,
  centroid FLOAT[512],
  embedding_count INTEGER DEFAULT 0
);

CREATE TABLE audio_transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audio_chunk_id INTEGER NOT NULL,
  offset_index INTEGER NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  transcription TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  is_input_device BOOLEAN NOT NULL DEFAULT TRUE,
  speaker_id INTEGER,
  transcription_engine TEXT NOT NULL DEFAULT 'Whisper',
  start_time REAL,
  end_time REAL,
  text_length INTEGER,
  sync_id TEXT,
  synced_at DATETIME,
  redacted_at INTEGER,
  FOREIGN KEY (audio_chunk_id) REFERENCES audio_chunks(id),
  FOREIGN KEY (speaker_id) REFERENCES speakers(id)
);

CREATE INDEX idx_frames_timestamp ON frames(timestamp);
CREATE INDEX idx_frames_app_name_timestamp ON frames(app_name, timestamp);
CREATE INDEX idx_audio_transcriptions_timestamp
  ON audio_transcriptions(timestamp);
CREATE INDEX idx_audio_transcriptions_speaker_id
  ON audio_transcriptions(speaker_id);
CREATE INDEX idx_audio_transcriptions_device
  ON audio_transcriptions(device);
CREATE UNIQUE INDEX idx_audio_transcription_chunk_text
  ON audio_transcriptions(audio_chunk_id, transcription);
`;

export interface SeedOptions {
  migrations?: readonly number[];
  rows?: boolean;
}

export function seedFixtureDatabase(
  db: Database,
  opts: SeedOptions = {},
): void {
  const migrations = opts.migrations ?? FIXTURE_MIGRATIONS;
  const includeRows = opts.rows ?? true;
  db.transaction(() => {
    db.exec(FIXTURE_DDL);
    const insertMigration = db.query(
      `INSERT INTO _sqlx_migrations
         (version, description, installed_on, success, checksum, execution_time)
       VALUES (?, ?, ?, 1, X'', 0)`,
    );
    for (const version of migrations) {
      insertMigration.run(version, `fixture migration ${version}`, FIXTURE_NOW);
    }
    if (includeRows) seedRows(db);
  }).immediate();
}

function seedRows(db: Database): void {
  const insertFrame = db.query(
    `INSERT INTO frames
       (id, video_chunk_id, offset_index, timestamp, app_name, window_name,
        browser_url, device_name, focused, full_text, text_source,
        capture_trigger, snapshot_path, document_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const longText = "n".repeat(70_000);
  const frames = [
    [
      1,
      1,
      0,
      "2026-01-05T09:00:00.123456+00:00",
      "Acme Mail",
      "Inbox — grace",
      null,
      "Built-in Display",
      1,
      "ada shared a note.\ngrace acknowledged it.",
      "accessibility",
      "app_switch",
      "/home/ada/.screenpipe/data/2026-01-05_09-00-00-monitor-1.jpg",
      null,
    ],
    [
      2,
      1,
      1,
      "2026-01-05T09:01:00Z",
      "Firefox",
      "Acme inbox",
      "https://mail.acme.example/inbox/42?tab=1",
      "Built-in Display",
      0,
      "A synthetic inbox item.",
      "ocr",
      "interval",
      null,
      null,
    ],
    [
      3,
      1,
      2,
      "2026-01-05 09:02:00.5+00:00",
      "Terminal",
      "Notes",
      null,
      "Built-in Display",
      1,
      "Review the local notes.",
      "hybrid",
      "interval",
      null,
      "/home/ada/notes/todo.md",
    ],
    [
      4,
      null,
      0,
      "2026-01-05T09:03:00Z",
      "Acme Mail",
      "Inbox",
      null,
      "Built-in Display",
      1,
      null,
      null,
      "snapshot",
      null,
      null,
    ],
    [
      5,
      null,
      0,
      "2026-01-05T09:04:00Z",
      "Acme Mail",
      "Inbox",
      null,
      "Built-in Display",
      1,
      "   ",
      "ocr",
      "snapshot",
      null,
      null,
    ],
    [
      6,
      1,
      3,
      "2026-01-05T09:05:00Z",
      "Notes",
      "Long note",
      null,
      "Built-in Display",
      1,
      longText,
      "accessibility",
      "interval",
      null,
      null,
    ],
    [
      7,
      1,
      4,
      "yesterday",
      "Notes",
      "Bad timestamp",
      null,
      "Built-in Display",
      1,
      "This row has no usable occurrence time.",
      "accessibility",
      "interval",
      null,
      null,
    ],
    [
      8,
      null,
      0,
      "2026-01-05T09:07:00Z",
      "",
      null,
      "not a url",
      "Built-in Display",
      null,
      "A frame without app or site subjects.",
      "ocr",
      "snapshot",
      null,
      null,
    ],
  ] as const;
  for (const values of frames) insertFrame.run(...values);

  db.query("INSERT INTO speakers (id, name) VALUES (?, ?)").run(1, "Grace");
  db.query("INSERT INTO speakers (id, name) VALUES (?, ?)").run(2, null);
  const insertChunk = db.query(
    `INSERT INTO audio_chunks (id, file_path, timestamp, transcription_status)
     VALUES (?, ?, ?, 'transcribed')`,
  );
  insertChunk.run(
    1,
    "/home/ada/.screenpipe/data/2026-01-06_10-00-00-mic.mp4",
    "2026-01-06T10:00:00Z",
  );
  insertChunk.run(
    2,
    "/home/ada/.screenpipe/data/2026-01-06_11-00-00-output.mp4",
    "2026-01-06T11:00:00Z",
  );

  const insertTranscription = db.query(
    `INSERT INTO audio_transcriptions
       (id, audio_chunk_id, offset_index, timestamp, transcription, device,
        is_input_device, speaker_id, transcription_engine, start_time, end_time,
        text_length)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertTranscription.run(
    1,
    1,
    0,
    "2026-01-06T10:00:00+00:00",
    "grace discussed the acme plan with linus.",
    "MacBook Microphone (input)",
    1,
    1,
    "whisper",
    12.5,
    18,
    42,
  );
  insertTranscription.run(
    2,
    2,
    0,
    "2026-01-06T11:00:00.123+00:00",
    "A synthetic system-audio transcript.",
    "Display Audio (output)",
    0,
    2,
    "whisper",
    0,
    4,
    36,
  );
  insertTranscription.run(
    3,
    1,
    1,
    "2026-01-06 10:10:00Z",
    "ada recorded a short local note.",
    "MacBook Microphone (input)",
    1,
    null,
    "whisper",
    null,
    null,
    32,
  );
}
