import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  MAX_FILENAME_CHARS,
  MAX_METADATA_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_TEXT_CHARS,
  ScreenpipeConnector,
  mapFrame,
  mapTranscription,
  openReadOnly,
  readFrames,
  readTranscriptions,
} from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

const OVERSIZED = "x".repeat(200_000);
const OBSERVED_AT = "2026-01-09T00:00:00.000Z";

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

      expect(frame?.full_text).toHaveLength(MAX_TEXT_CHARS + 2);
      expect(spoken?.transcription).toHaveLength(MAX_TEXT_CHARS + 2);
      // Only the event's own text is read at the text bound. A window title or
      // a device name reaching an event at that size would let one batch carry
      // hundreds of megabytes of metadata around ten-character screens.
      expect(frame?.window_name).toHaveLength(MAX_METADATA_CHARS + 2);
      expect(frame?.app_name).toHaveLength(MAX_METADATA_CHARS + 2);
      expect(spoken?.device).toHaveLength(MAX_METADATA_CHARS + 2);
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

      const bounds: [string | null | undefined, number][] = [
        [frame?.full_text, MAX_TEXT_CHARS],
        [spoken?.transcription, MAX_TEXT_CHARS],
        [frame?.app_name, MAX_METADATA_CHARS],
        [frame?.window_name, MAX_METADATA_CHARS],
        [spoken?.device, MAX_METADATA_CHARS],
      ];
      for (const [value, bound] of bounds) {
        // The read stays past the event bound whatever the pair does at the
        // cut, so truncation is still detectable downstream.
        expect(value?.length).toBeLessThanOrEqual(bound + 2);
        expect(value?.length).toBeGreaterThan(bound);
        // A cut between the halves of a surrogate pair would not survive a
        // round trip through SQLite, so the pair is dropped whole.
        expect(/[\uD800-\uDBFF]$/.test(value ?? "")).toBe(false);
      }

      // display_name reaches the staging floor as an entity candidate's title,
      // so what the event carries has to be bounded too.
      const event = mapFrame(frame!, OBSERVED_AT);
      expect(event.subjects[0]?.display_name?.length).toBeLessThanOrEqual(
        MAX_SUBJECT_CHARS,
      );
      expect(String(event.metadata["window_name"]).length).toBeLessThanOrEqual(
        MAX_METADATA_CHARS,
      );
    } finally {
      db.close();
    }
  });

  test("astral text past the bound is flagged as truncated", () => {
    const fixture = createFixtureDatabase({ rows: false });
    // Every character is a surrogate pair, so the cut always lands on a pair
    // boundary. A read that stopped one unit past the event bound would drop
    // the split half and hand mapping a value of exactly the bound, which
    // reads as untruncated while half the row was thrown away.
    const astral = "\u{1f600}".repeat(100_000);
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-05T09:00:00Z",
      fullText: astral,
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-06T10:00:00Z",
      transcription: astral,
    });
    fixture.writer.close();

    const db: Database = openReadOnly(fixture.path);
    try {
      const frame = readFrames(db, 0, 1)[0];
      const spoken = readTranscriptions(db, 0, 1)[0];
      if (frame === undefined || spoken === undefined) {
        throw new Error("expected one row from each table");
      }
      const screen = mapFrame(frame, OBSERVED_AT);
      const heard = mapTranscription(spoken, OBSERVED_AT);

      expect(screen.metadata["text_truncated"]).toBe(true);
      expect(screen.text).toHaveLength(MAX_TEXT_CHARS);
      expect(heard.metadata["text_truncated"]).toBe(true);
      expect(heard.text).toHaveLength(MAX_TEXT_CHARS);
    } finally {
      db.close();
    }
  });

  test("one oversized row cannot inflate a batch through its metadata", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    const huge = "x".repeat(70_000);
    fixture.writer
      .query(
        `INSERT INTO frames
           (id, video_chunk_id, offset_index, timestamp, app_name, window_name,
            browser_url, device_name, focused, full_text, text_source,
            capture_trigger, snapshot_path, document_path)
         VALUES (1, NULL, 0, '2026-01-05T09:00:00Z', ?, ?, ?, ?, 1,
                 'short text', ?, ?, ?, ?)`,
      )
      .run(
        huge,
        huge,
        `https://mail.acme.example/${huge}`,
        huge,
        huge,
        huge,
        `/home/ada/${huge}.jpg`,
        huge,
      );
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    // Every column here is provider-controlled. Bounding the event's text alone
    // leaves the rest free to carry the whole row into memory, five hundred
    // times per batch, whatever the screen actually said.
    const event = (await connector.backfill(null)).events[0];
    if (event === undefined) throw new Error("expected one event");

    expect(event.text).toBe("short text");
    for (const key of [
      "app_name",
      "window_name",
      "browser_url",
      "document_path",
      "device_name",
      "text_source",
      "capture_trigger",
    ]) {
      expect(String(event.metadata[key])).toHaveLength(MAX_METADATA_CHARS);
    }
    expect(event.metadata["metadata_truncated"]).toBe(true);
    for (const subject of event.subjects) {
      expect(subject.display_name?.length).toBeLessThanOrEqual(
        MAX_SUBJECT_CHARS,
      );
    }
    // A path the read had to cut has no last component left to name.
    expect(event.attachments).toEqual([
      { attachment_id: "snapshot", media_type: "image/jpeg" },
    ]);
    expect(JSON.stringify(event).length).toBeLessThan(20_000);
    await connector.revoke();
  });

  test("a snapshot name longer than a filesystem allows is not carried", () => {
    // Longer than NAME_MAX on every filesystem screenpipe writes to, so it
    // cannot be the name of a file that exists.
    const overlong = `${"n".repeat(300)}.jpg`;
    expect(overlong.length).toBeGreaterThan(MAX_FILENAME_CHARS);
    const attachments = mapFrame(
      {
        id: 1,
        timestamp: "2026-01-05T09:00:00Z",
        app_name: null,
        window_name: null,
        browser_url: null,
        device_name: "Fixture Display",
        focused: true,
        full_text: "text",
        text_source: null,
        capture_trigger: null,
        snapshot_path: `/home/ada/${overlong}`,
        document_path: null,
        video_chunk_id: null,
        offset_index: 0,
      },
      OBSERVED_AT,
    ).attachments;

    expect(attachments).toEqual([
      { attachment_id: "snapshot", media_type: "image/jpeg" },
    ]);
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
      expect(frames[5]?.full_text).toHaveLength(MAX_TEXT_CHARS + 2);
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
