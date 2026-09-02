import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  MAX_TEXT_CHARS,
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
