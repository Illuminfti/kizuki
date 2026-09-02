import { afterEach, describe, expect, test } from "bun:test";
import { computeContentHash, validateEventInput } from "@kizuki/core";
import {
  BATCH_LIMIT,
  ScreenpipeConnector,
  parseCursor,
} from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

describe("ScreenpipeConnector backfill", () => {
  test("first backfill emits the settled fixture rows in id order with the documented skip counters", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
      "frame:2",
      "frame:3",
      "frame:6",
      "frame:8",
      "transcription:1",
      "transcription:2",
      "transcription:3",
    ]);
    if (batch.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(batch.cursor)).toEqual({
      schema: "kizuki.screenpipe-cursor/v1",
      last_frame_id: 8,
      last_transcription_id: 3,
      skipped: {
        frames_without_text: 2,
        frames_bad_timestamp: 1,
        transcriptions_bad_timestamp: 0,
      },
    });
    await connector.revoke();
  });

  test("a batch never exceeds BATCH_LIMIT", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= 1_200; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: `frame ${id}`,
        });
      }
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const counts: number[] = [];
    let cursor: string | null = null;
    for (let call = 0; call < 4; call += 1) {
      const batch = await connector.backfill(cursor);
      counts.push(batch.events.length);
      cursor = batch.cursor;
    }

    expect(counts).toEqual([BATCH_LIMIT, BATCH_LIMIT, 200, 0]);
    if (cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(cursor).last_frame_id).toBe(1_200);
    await connector.revoke();
  });

  test("the same cursor and now yield identical events", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const first = await connector.backfill(null);
    const second = await connector.backfill(null);

    expect(second).toEqual(first);
    await connector.revoke();
  });

  test("an unusable foreign key does not abort the batch", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "first",
      videoChunkId: 0,
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:01:00Z",
      fullText: "second",
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:02:00Z",
      transcription: "spoken words",
      speakerId: 0,
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
      "frame:2",
      "transcription:1",
    ]);
    expect(batch.events[0]?.metadata["video_chunk_id"]).toBeNull();
    expect(batch.events[2]?.metadata["speaker_id"]).toBeNull();
    expect(batch.events[2]?.subjects.map(({ subject_id }) => subject_id)).toEqual(
      ["screenpipe:audio-device:fixture-microphone"],
    );
    if (batch.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(batch.cursor).last_frame_id).toBe(2);
    await connector.revoke();
  });

  test("a timestamp outside RFC3339 range is skipped, not emitted", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    // Valid RFC3339 in the file, but its UTC instant leaves the four-digit
    // year range. Emitting it would fail validateEventInput, and the ingest
    // runner keeps the previous checkpoint whenever a batch reports an error,
    // so this one row would stop the source from ever advancing again.
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "9999-12-31T23:00:00-05:00",
      fullText: "beyond the last representable year",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "behind it",
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "0001-01-01T00:00:00+05:00",
      transcription: "before the first representable year",
    });
    insertTranscription(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:01:00Z",
      transcription: "behind it",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:2",
      "transcription:2",
    ]);
    expect(batch.events.every((event) => validateEventInput(event).ok)).toBe(
      true,
    );
    if (batch.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(batch.cursor).skipped).toEqual({
      frames_without_text: 0,
      frames_bad_timestamp: 1,
      transcriptions_bad_timestamp: 1,
    });
    await connector.revoke();
  });

  test("a timestamp stored as a number is skipped, not fatal", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    // The column is declared TIMESTAMP, which SQLite gives NUMERIC affinity, so
    // an older screenpipe or a restored dump can store a numeric-looking value
    // as an INTEGER. Failing the read would abandon every row behind it for
    // good: the runner keeps the checkpoint whenever a batch reports an error.
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: 20260105,
      fullText: "ahead of the good row",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "behind it",
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: 20260106,
      transcription: "spoken ahead of the good row",
    });
    insertTranscription(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:01:00Z",
      transcription: "behind it",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:2",
      "transcription:2",
    ]);
    if (batch.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(batch.cursor).skipped).toEqual({
      frames_without_text: 0,
      frames_bad_timestamp: 1,
      transcriptions_bad_timestamp: 1,
    });
    const health = await connector.health();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain("2 unparsable timestamps");
    await connector.revoke();
  });

  test("a second backfill from the same cursor is all duplicates", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    const second = await connector.backfill(null);

    // The ledger deduplicates on (connector_id, source_record_id) and the
    // content hash, so identical values on both passes are what makes a
    // repeated sweep idempotent.
    expect(second.events.map((event) => event.source_record_id)).toEqual(
      first.events.map((event) => event.source_record_id),
    );
    expect(second.events.map(computeContentHash)).toEqual(
      first.events.map(computeContentHash),
    );
    await connector.revoke();
  });
});

