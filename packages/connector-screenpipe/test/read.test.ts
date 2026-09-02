import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  MAX_TEXT_CHARS,
  mapFrame,
  openReadOnly,
  readFrames,
  readTranscriptions,
} from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  insertFrame,
  insertTranscription,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

const OVERSIZED = "x".repeat(200_000);

describe("screenpipe row readers", () => {
  test("an oversized row is bounded before it reaches memory", () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-05T09:00:00Z",
      fullText: OVERSIZED,
      windowName: OVERSIZED,
      appName: OVERSIZED,
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-06T10:00:00Z",
      transcription: OVERSIZED,
      device: OVERSIZED,
    });
    fixture.writer.close();

    const db: Database = openReadOnly(fixture.path);
    try {
      const frame = readFrames(db, 0, 1)[0];
      const spoken = readTranscriptions(db, 0, 1)[0];

      expect(frame?.full_text).toHaveLength(MAX_TEXT_CHARS + 1);
      expect(frame?.window_name).toHaveLength(MAX_TEXT_CHARS + 1);
      expect(frame?.app_name).toHaveLength(MAX_TEXT_CHARS + 1);
      expect(spoken?.transcription).toHaveLength(MAX_TEXT_CHARS + 1);
      expect(spoken?.device).toHaveLength(MAX_TEXT_CHARS + 1);
    } finally {
      db.close();
    }
  });

  test("astral text is bounded in code units, not code points", () => {
    const fixture = createFixtureDatabase({ rows: false });
    // SQLite counts code points and the event bound counts UTF-16 code units,
    // so a column of astral characters reaches the event at twice the
    // documented length unless the reader cuts it again.
    const astral = "A\u{1F600}".repeat(200_000);
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-05T09:00:00Z",
      fullText: astral,
      appName: astral,
      windowName: astral,
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-06T10:00:00Z",
      transcription: astral,
      device: astral,
    });
    fixture.writer.close();

    const db: Database = openReadOnly(fixture.path);
    try {
      const frame = readFrames(db, 0, 1)[0];
      const spoken = readTranscriptions(db, 0, 1)[0];

      for (const value of [
        frame?.full_text,
        frame?.app_name,
        frame?.window_name,
        spoken?.transcription,
        spoken?.device,
      ]) {
        // One unit past the event bound is kept where the pair allows it, so
        // truncation is still detectable downstream.
        expect(value?.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 1);
        expect(value?.length).toBeGreaterThanOrEqual(MAX_TEXT_CHARS);
        // A cut between the halves of a surrogate pair would not survive a
        // round trip through SQLite, so the pair is dropped whole.
        expect(/[\uD800-\uDBFF]$/.test(value ?? "")).toBe(false);
      }

      // display_name reaches the staging floor as an entity candidate's title,
      // so the reader's bound has to be what the event carries.
      const event = mapFrame(frame!, "2026-01-09T00:00:00.000Z");
      expect(event.subjects[0]?.display_name?.length).toBeLessThanOrEqual(
        MAX_TEXT_CHARS + 1,
      );
      expect(String(event.metadata["window_name"]).length).toBeLessThanOrEqual(
        MAX_TEXT_CHARS + 1,
      );
    } finally {
      db.close();
    }
  });

  test("text shorter than the bound is read verbatim", () => {
    const fixture = createFixtureDatabase();
    fixture.writer.close();

    const db: Database = openReadOnly(fixture.path);
    try {
      const frames = readFrames(db, 0, 8);

      expect(frames[1]?.browser_url).toBe(
        "https://mail.acme.example/inbox/42?tab=1",
      );
      expect(frames[5]?.full_text).toHaveLength(MAX_TEXT_CHARS + 1);
      expect(frames[3]?.full_text).toBeNull();
    } finally {
      db.close();
    }
  });

  test("an unusable offset or chunk link degrades to a default", () => {
    const fixture = createFixtureDatabase({ rows: false });
    // INTEGER affinity keeps a non-numeric string as text, and NOT NULL is
    // still satisfied, so a corrupt row reaches the reader intact.
    fixture.writer
      .query(
        `INSERT INTO frames
           (id, video_chunk_id, offset_index, timestamp, app_name, window_name,
            browser_url, device_name, focused, full_text, text_source,
            capture_trigger, snapshot_path, document_path)
         VALUES (1, NULL, 'not an offset', '2026-01-05T09:00:00Z', 'Acme Mail',
                 NULL, NULL, 'Fixture Display', 1, 'text', 'accessibility',
                 'fixture', NULL, NULL)`,
      )
      .run();
    fixture.writer
      .query(
        `INSERT INTO audio_transcriptions
           (id, audio_chunk_id, offset_index, timestamp, transcription, device,
            is_input_device, speaker_id, transcription_engine, start_time, end_time)
         VALUES (1, 'not a chunk', -3, '2026-01-06T10:00:00Z', 'spoken',
                 'Fixture Microphone', 1, NULL, 'fixture-engine', 0, 1)`,
      )
      .run();
    fixture.writer.close();

    const db: Database = openReadOnly(fixture.path);
    try {
      expect(readFrames(db, 0, 1)[0]?.offset_index).toBe(0);
      const spoken = readTranscriptions(db, 0, 1)[0];
      expect(spoken?.audio_chunk_id).toBe(0);
      expect(spoken?.offset_index).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a blob in a text column stays unusable", () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer
      .query(
        `INSERT INTO frames
           (id, video_chunk_id, offset_index, timestamp, app_name, window_name,
            browser_url, device_name, focused, full_text, text_source,
            capture_trigger, snapshot_path, document_path)
         VALUES (1, NULL, 0, '2026-01-05T09:00:00Z', X'00ff', NULL, NULL,
                 'Fixture Display', 1, 'text', 'accessibility', 'fixture',
                 NULL, NULL)`,
      )
      .run();
    fixture.writer.close();

    const db: Database = openReadOnly(fixture.path);
    try {
      expect(readFrames(db, 0, 1)[0]?.app_name).toBeNull();
    } finally {
      db.close();
    }
  });
});
