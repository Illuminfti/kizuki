import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { InMemoryLedger } from "../../connectors/src/testkit";
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
    const cursor = parseCursor(batch.cursor);
    expect(cursor.last_frame_id).toBe(8);
    expect(cursor.last_transcription_id).toBe(3);
    expect(cursor.skipped).toEqual({
      frames_without_text: 2,
      frames_bad_timestamp: 1,
      frames_offset_unknown: 0,
      transcriptions_bad_timestamp: 0,
      transcriptions_bad_offset: 0,
      transcriptions_offset_unknown: 0,
    });
    expect(cursor.oldest_skipped_frame_id).toBe(4);
    expect(cursor.phase).toBe("exhausted");
    expect(cursor.db_path).toBe(path.resolve(fixture.path));
    expect(cursor.db_fingerprint).toMatch(/^[0-9a-f]{64}$/);
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

  test("the settle window holds back recent frames", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-08T10:00:00Z",
      fullText: "settling text",
    });
    let now = Date.parse("2026-01-08T10:01:00Z");
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 300 },
      { now: () => now },
    );

    const held = await connector.backfill(null);
    expect(held.events).toEqual([]);
    if (held.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(held.cursor).last_frame_id).toBe(0);

    now = Date.parse("2026-01-08T10:05:00Z");
    const settled = await connector.backfill(held.cursor);
    expect(settled.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
    ]);
    await connector.revoke();
  });

  test("late OCR text inside the settle window is captured", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-08T10:00:00Z",
      fullText: null,
    });
    let now = Date.parse("2026-01-08T10:01:00Z");
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 300 },
      { now: () => now },
    );

    const held = await connector.backfill(null);
    fixture.writer
      .query("UPDATE frames SET full_text = ? WHERE id = 1")
      .run("late OCR text");
    now = Date.parse("2026-01-08T10:05:00Z");
    const captured = await connector.backfill(held.cursor);

    expect(captured.events.map(({ text }) => text)).toEqual(["late OCR text"]);
    await connector.revoke();
  });

  test("a frame without text past the settle window is skipped for good", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: null,
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const skipped = await connector.backfill(null);
    fixture.writer
      .query("UPDATE frames SET full_text = ? WHERE id = 1")
      .run("too late");
    const afterUpdate = await connector.backfill(skipped.cursor);

    expect(afterUpdate.events).toEqual([]);
    if (afterUpdate.cursor === null) {
      throw new Error("expected a screenpipe cursor");
    }
    expect(parseCursor(afterUpdate.cursor).skipped.frames_without_text).toBe(1);
    await connector.revoke();
  });

  test("an out-of-order recent timestamp stops the walk without skipping the row", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "old one",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-08T10:00:00Z",
      fullText: "recent",
    });
    insertFrame(fixture.writer, {
      id: 3,
      timestamp: "2026-01-02T00:00:00Z",
      fullText: "old two",
    });
    let now = Date.parse("2026-01-08T10:01:00Z");
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 300 },
      { now: () => now },
    );

    const first = await connector.backfill(null);
    expect(first.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
    ]);
    if (first.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(first.cursor).last_frame_id).toBe(1);

    now = Date.parse("2026-01-08T10:05:00Z");
    const second = await connector.backfill(first.cursor);
    expect(second.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:2",
      "frame:3",
    ]);
    await connector.revoke();
  });

  test("since seeds the cursor past older rows", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    for (const [id, timestamp] of [
      [1, "2026-01-01T00:00:00Z"],
      [2, "2026-01-02T00:00:00Z"],
      [3, "2026-01-03T00:00:00Z"],
    ] as const) {
      insertFrame(fixture.writer, { id, timestamp, fullText: `frame ${id}` });
    }
    const connector = new ScreenpipeConnector(
      {
        path: fixture.path,
        since: "2026-01-02T00:00:00Z",
        settle_seconds: 0,
      },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:2",
      "frame:3",
    ]);
    await connector.revoke();
  });

  test("double backfill through InMemoryLedger is all duplicates", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    const second = await connector.backfill(null);
    const ledger = new InMemoryLedger();

    expect(
      ledger.acceptMany(first.events).every(({ status }) => status === "stored"),
    ).toBe(true);
    expect(
      ledger
        .acceptMany(second.events)
        .every(({ status }) => status === "duplicate"),
    ).toBe(true);
    await connector.revoke();
  });
});
