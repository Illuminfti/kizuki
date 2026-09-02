import { afterEach, describe, expect, test } from "bun:test";
import { ScreenpipeConnector, parseCursor } from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

describe("ScreenpipeConnector settle window", () => {
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

  test("a row dated far ahead of the clock does not park the walk", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "settled",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2099-01-01T00:00:00Z",
      fullText: "dated in the future",
    });
    insertFrame(fixture.writer, {
      id: 3,
      timestamp: "2026-01-02T00:00:00Z",
      fullText: "behind the future row",
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2099-01-01T00:00:00Z",
      transcription: "dated in the future",
    });
    insertTranscription(fixture.writer, {
      id: 2,
      timestamp: "2026-01-02T00:00:00Z",
      transcription: "behind the future row",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 300 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
      "frame:2",
      "frame:3",
      "transcription:1",
      "transcription:2",
    ]);
    if (batch.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(batch.cursor).last_frame_id).toBe(3);
    expect(parseCursor(batch.cursor).last_transcription_id).toBe(2);
    await connector.revoke();
  });

  test("a row inside the settle window ahead of the clock is still held", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-08T10:01:00Z",
      fullText: "one minute of clock skew",
    });
    let now = Date.parse("2026-01-08T10:00:00Z");
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 300 },
      { now: () => now },
    );

    const held = await connector.backfill(null);
    expect(held.events).toEqual([]);

    now = Date.parse("2026-01-08T10:06:00Z");
    const settled = await connector.backfill(held.cursor);
    expect(settled.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
    ]);
    await connector.revoke();
  });
});
