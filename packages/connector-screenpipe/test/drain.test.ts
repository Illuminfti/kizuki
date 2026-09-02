import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { SyncBatch } from "@kizuki/core";
import { BATCH_LIMIT, ScreenpipeConnector, parseCursor } from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

/** Longer than any page a single call reads, so paging has to carry the walk. */
const LONG_IDLE_RUN = 10_000;

describe("ScreenpipeConnector drain signal", () => {
  test("a full page of skipped frames still yields the rows behind it", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= BATCH_LIMIT; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: null,
        });
      }
      insertFrame(fixture.writer, {
        id: BATCH_LIMIT + 1,
        timestamp: "2026-01-01T00:00:00Z",
        fullText: "behind the skipped page",
      });
      insertTranscription(fixture.writer, {
        id: 1,
        timestamp: "2026-01-01T00:00:00Z",
        transcription: "behind the skipped page too",
      });
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      `frame:${BATCH_LIMIT + 1}`,
      "transcription:1",
    ]);
    const drained = await connector.backfill(batch.cursor);
    expect(drained.events).toEqual([]);
    if (drained.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(drained.cursor).skipped.frames_without_text).toBe(
      BATCH_LIMIT,
    );
    await connector.revoke();
  });

  test("an idle run of any length still yields the row behind it", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    const total = LONG_IDLE_RUN + 1;
    fixture.writer.transaction(() => {
      for (let id = 1; id <= total; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: id === total ? "the row behind the idle run" : null,
        });
      }
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    // A locked or unchanged screen writes frames without text for as long as
    // it stays that way. Ending the call on a page count would report no
    // events with rows still behind the checkpoint, and the only signal a host
    // reads is the event count, so the run has to be walked out in one call.
    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      `frame:${total}`,
    ]);
    await connector.revoke();
  });

  test("an empty batch means every settled row was read", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    const total = LONG_IDLE_RUN + 2;
    fixture.writer.transaction(() => {
      for (let id = 1; id <= total; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: id > LONG_IDLE_RUN ? `frame ${id}` : null,
        });
      }
      insertTranscription(fixture.writer, {
        id: 1,
        timestamp: "2026-01-01T00:00:00Z",
        transcription: "the last row of the drain",
      });
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let call = 0; call < 10; call += 1) {
      const batch: SyncBatch = await connector.backfill(cursor);
      cursor = batch.cursor;
      if (batch.events.length === 0) break;
      collected.push(
        ...batch.events.map(({ source_record_id }) => source_record_id),
      );
    }

    expect(collected).toEqual([
      `frame:${LONG_IDLE_RUN + 1}`,
      `frame:${total}`,
      "transcription:1",
    ]);
    if (cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(cursor).last_frame_id).toBe(total);
    await connector.revoke();
  });
});

describe("ScreenpipeConnector read bounds", () => {
  test("a nearly full batch still reads full pages", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= BATCH_LIMIT - 1; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: `frame ${id}`,
        });
      }
      // An idle screen produces a long contiguous run of frames without text.
      for (let id = BATCH_LIMIT; id <= BATCH_LIMIT + 3_000; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: null,
        });
      }
    })();
    const reader = new Database(fixture.path, {
      readonly: true,
      safeIntegers: true,
    });
    const statements = spyOn(reader, "query");
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z", () => reader),
    );

    const batch = await connector.backfill(null);

    expect(batch.events).toHaveLength(BATCH_LIMIT - 1);
    // One statement per skipped row is what a page sized by the remaining
    // event budget degrades to.
    expect(statements.mock.calls.length).toBeLessThan(40);
    await connector.revoke();
  });

  test("a long frame walk still reads the transcription table", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= LONG_IDLE_RUN; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: null,
        });
      }
      insertTranscription(fixture.writer, {
        id: 1,
        timestamp: "2026-01-01T00:00:00Z",
        transcription: "spoken while the screen showed nothing",
      });
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    // Frames are walked first: spending a whole call on them must not hide a
    // table the caller would otherwise read in the same call.
    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "transcription:1",
    ]);
    await connector.revoke();
  });

  test("a saturated frame table still leaves room for transcriptions", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= BATCH_LIMIT + 200; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: `frame ${id}`,
        });
      }
      for (let id = 1; id <= 3; id += 1) {
        insertTranscription(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          transcription: `spoken ${id}`,
        });
      }
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    // A machine that is being used keeps the frame table saturated, so a batch
    // frames may fill on their own never reaches the other declared kind.
    const batch = await connector.backfill(null);

    expect(batch.events).toHaveLength(BATCH_LIMIT);
    expect(
      batch.events
        .filter(({ kind }) => kind === "audio_transcription")
        .map(({ source_record_id }) => source_record_id),
    ).toEqual(["transcription:1", "transcription:2", "transcription:3"]);
    await connector.revoke();
  });

  test("neither table starves the other while both stay behind", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= 3_000; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: `frame ${id}`,
        });
        insertTranscription(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          transcription: `spoken ${id}`,
        });
      }
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const spoken: number[] = [];
    let cursor: string | null = null;
    for (let call = 0; call < 4; call += 1) {
      const batch: SyncBatch = await connector.backfill(cursor);
      cursor = batch.cursor;
      expect(batch.events).toHaveLength(BATCH_LIMIT);
      spoken.push(
        batch.events.filter(({ kind }) => kind === "audio_transcription")
          .length,
      );
    }

    expect(spoken).toEqual([100, 100, 100, 100]);
    await connector.revoke();
  });

  test("a batch stops at BATCH_LIMIT with rows still behind it", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= BATCH_LIMIT + 10; id += 1) {
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

    const batch = await connector.backfill(null);

    expect(batch.events).toHaveLength(BATCH_LIMIT);
    if (batch.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(batch.cursor).last_frame_id).toBe(BATCH_LIMIT);
    await connector.revoke();
  });
});
