import { afterEach, describe, expect, test } from "bun:test";
import {
  BATCH_LIMIT,
  ScreenpipeConnector,
  createScreenpipeConnector,
  parseCursor,
  replayFrom,
  seedAfterIds,
} from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

describe("screenpipe P1 regressions", () => {
  test("since uses normalized instants across mixed timestamp formats", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01 23:00:00+00:00",
      fullText: "legacy before",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-02T00:00:00Z",
      fullText: "on since",
    });
    insertFrame(fixture.writer, {
      id: 3,
      timestamp: "2026-01-02 01:00:00+00:00",
      fullText: "legacy after",
    });
    const seeded = seedAfterIds(
      fixture.writer,
      "2026-01-02T00:00:00.000Z",
      null,
    );
    expect(seeded.frame).toBe(1);

    const connector = new ScreenpipeConnector(
      {
        path: fixture.path,
        since: "2026-01-02T00:00:00.000Z",
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

  test("timezone-less source rows are quarantined unless a zone is configured", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-05 09:00:00",
      fullText: "local unknown",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-05T09:01:00Z",
      fullText: "offset known",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const skipped = await connector.backfill(null);
    expect(skipped.events.map(({ source_record_id }) => source_record_id)).toEqual(
      ["frame:2"],
    );
    if (skipped.cursor === null) throw new Error("expected a cursor");
    expect(parseCursor(skipped.cursor).skipped.frames_offset_unknown).toBe(1);
    await connector.revoke();

    const zoned = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0, timezone: "Z" },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const recovered = await zoned.backfill(null);
    expect(
      recovered.events.map(({ source_record_id }) => source_record_id),
    ).toEqual(["frame:1", "frame:2"]);
    await zoned.revoke();
  });

  test("invalid audio offsets are quarantined instead of collapsing to the base time", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-06T10:00:00Z",
      transcription: "valid offset",
      startTime: 1.5,
    });
    insertTranscription(fixture.writer, {
      id: 2,
      timestamp: "2026-01-06T10:01:00Z",
      transcription: "overflow offset",
      startTime: 86_400,
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const batch = await connector.backfill(null);
    expect(batch.events.map(({ source_record_id, occurred_at }) => [
      source_record_id,
      occurred_at,
    ])).toEqual([["transcription:1", "2026-01-06T10:00:01.500Z"]]);
    if (batch.cursor === null) throw new Error("expected a cursor");
    expect(parseCursor(batch.cursor).skipped.transcriptions_bad_offset).toBe(1);
    const health = await connector.health();
    expect(health.state).toBe("degraded");
    expect(health.detail).toContain("transcriptions_bad_offset=1");
    expect(health.detail).toContain("oldest_skipped_transcription=2");
    await connector.revoke();
  });

  test("a growing frame stream cannot starve earlier audio", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer
      .query(
        `INSERT INTO audio_chunks (id, file_path, timestamp, transcription_status)
         VALUES (1, '/tmp/a.mp4', '2026-01-01T00:00:00Z', 'transcribed')`,
      )
      .run();
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      transcription: "older audio",
    });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= BATCH_LIMIT + 10; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-02T00:00:00Z",
          fullText: `later frame ${id}`,
        });
      }
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    expect(first.events[0]?.source_record_id).toBe("transcription:1");
    expect(
      first.events.filter((event) => event.kind === "audio_transcription"),
    ).toHaveLength(1);
    expect(first.events.length).toBeLessThanOrEqual(BATCH_LIMIT);
    await connector.revoke();
  });

  test("frame and audio events merge in global occurrence order across pages", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer
      .query(
        `INSERT INTO audio_chunks (id, file_path, timestamp, transcription_status)
         VALUES (1, '/tmp/a.mp4', '2026-01-01T00:00:00Z', 'transcribed')`,
      )
      .run();
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "frame first",
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:30Z",
      transcription: "audio middle",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:01:00Z",
      fullText: "frame last",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const batch = await connector.backfill(null);
    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
      "transcription:1",
      "frame:2",
    ]);
    await connector.revoke();
  });

  test("replacing the database with reused row ids fails closed", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    fixture.writer.exec("DELETE FROM audio_transcriptions");
    fixture.writer.exec("DELETE FROM frames");
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-02-01T00:00:00Z",
      fullText: "reused id",
    });

    await expect(connector.sync(first.cursor)).rejects.toMatchObject({
      code: "reset_detected",
    });
    await connector.revoke();
  });

  test("a rebound path is reset_detected", async () => {
    const original = createFixtureDatabase();
    const replacement = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: original.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    await connector.revoke();

    const rebound = new ScreenpipeConnector(
      { path: replacement.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    await expect(rebound.sync(first.cursor)).rejects.toMatchObject({
      code: "reset_detected",
    });
    await rebound.revoke();
  });

  test("backfill drains the snapshot watermark and ignores later inserts", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "inside snapshot",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:01:00Z",
      fullText: "after snapshot",
    });
    const second = await connector.backfill(first.cursor);
    expect(second.events).toEqual([]);
    if (second.cursor === null) throw new Error("expected a cursor");
    expect(parseCursor(second.cursor).phase).toBe("exhausted");

    const live = await connector.sync(second.cursor);
    expect(live.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:2",
    ]);
    await connector.revoke();
  });

  test("one empty settle gap is caught_up, not exhausted, and later snapshot rows drain", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-08T10:00:00Z",
      fullText: "settling",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "older after gap",
    });
    let now = Date.parse("2026-01-08T10:01:00Z");
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 300 },
      { now: () => now },
    );
    const held = await connector.backfill(null);
    expect(held.events).toEqual([]);
    if (held.cursor === null) throw new Error("expected a cursor");
    expect(parseCursor(held.cursor).phase).toBe("caught_up");
    expect(parseCursor(held.cursor).last_frame_id).toBe(0);

    now = Date.parse("2026-01-08T10:05:00Z");
    const drained = await connector.backfill(held.cursor);
    expect(drained.events.map(({ source_record_id }) => source_record_id)).toEqual(
      ["frame:1", "frame:2"],
    );
    await connector.revoke();
  });

  test("replayFrom re-reads from a skipped row without dropping identity", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    if (first.cursor === null) throw new Error("expected a cursor");
    const replayed = replayFrom(parseCursor(first.cursor), { frame: 3 });
    const again = await connector.backfill(JSON.stringify(replayed));
    expect(
      again.events.some((event) => event.source_record_id === "frame:6"),
    ).toBe(true);
    await connector.revoke();
  });

  test("fixture drain uses snapshot exhaustion rather than the first empty gap", async () => {
    const events = await createScreenpipeConnector({
      path: ":memory:",
    }).fixture();
    expect(events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
      "frame:2",
      "frame:3",
      "frame:6",
      "frame:8",
      "transcription:1",
      "transcription:2",
      "transcription:3",
    ]);
    expect(events.every((event) => event.sensitivity_hint === "private")).toBe(
      true,
    );
  });
});
