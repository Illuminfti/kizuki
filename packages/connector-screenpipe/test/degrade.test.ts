import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ScreenpipeConnector, parseCursor } from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

/**
 * SQLite columns are dynamically typed, so a value of any storage class
 * satisfies a `TEXT NOT NULL` declaration. A restored dump, a foreign writer or
 * a corrupt page can therefore put a blob where this connector expects text.
 */
function insertFrameWithBlobDeviceName(
  writer: Database,
  id: number,
): void {
  writer
    .query(
      `INSERT INTO frames
         (id, video_chunk_id, offset_index, timestamp, app_name, window_name,
          browser_url, device_name, focused, full_text, text_source,
          capture_trigger, snapshot_path, document_path)
       VALUES (?, NULL, 0, '2026-01-01T00:00:00Z', 'Acme Mail', NULL, NULL,
               X'00ff', 1, 'text behind a blob', 'accessibility', 'fixture',
               NULL, NULL)`,
    )
    .run(id);
}

function insertTranscriptionWithBlobText(
  writer: Database,
  id: number,
): void {
  writer
    .query(
      `INSERT INTO audio_transcriptions
         (id, audio_chunk_id, offset_index, timestamp, transcription, device,
          is_input_device, speaker_id, transcription_engine, start_time, end_time)
       VALUES (?, 1, 0, '2026-01-01T00:00:00Z', X'00ff', 'Fixture Microphone',
               1, NULL, 'fixture-engine', 0, 1)`,
    )
    .run(id);
}

describe("ScreenpipeConnector unreadable columns", () => {
  test("a metadata column that is not text degrades rather than failing the page", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "in front of the blob",
    });
    insertFrameWithBlobDeviceName(fixture.writer, 2);
    insertFrame(fixture.writer, {
      id: 3,
      timestamp: "2026-01-01T00:00:01Z",
      fullText: "behind the blob",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    // The display name a frame was captured on is metadata: it is not part of
    // the record id, the time, the text or any subject, so one unusable value
    // must not cost the rows around it.
    const batch = await connector.backfill(null);

    expect(
      batch.events.map(({ source_record_id }) => source_record_id),
    ).toEqual(["frame:1", "frame:2", "frame:3"]);
    expect(batch.events[1]?.metadata["device_name"]).toBe("");
    expect((await connector.health()).state).toBe("ok");
    await connector.revoke();
  });

  test("a payload column that is not text keeps the rows in front of it", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      transcription: "in front of the blob",
    });
    insertTranscriptionWithBlobText(fixture.writer, 2);
    insertTranscription(fixture.writer, {
      id: 3,
      timestamp: "2026-01-01T00:00:01Z",
      transcription: "behind the blob",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    // Validating the whole page first would abandon row 1 on this call and on
    // every later one, because the runner keeps the previous checkpoint
    // whenever a batch reports an error.
    const batch = await connector.backfill(null);

    expect(
      batch.events.map(({ source_record_id }) => source_record_id),
    ).toEqual(["transcription:1"]);
    if (batch.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(batch.cursor).last_transcription_id).toBe(1);
    await connector.revoke();
  });

  test("a stalled walk turns health red instead of reporting ok", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertTranscriptionWithBlobText(fixture.writer, 1);
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    await connector.backfill(null);
    const health = await connector.health();

    expect(health.state).toBe("misconfigured");
    expect(health.detail).toBe(
      "kizuki.screenpipe: audio_transcriptions.transcription has an invalid value",
    );
    await connector.revoke();
  });
});
