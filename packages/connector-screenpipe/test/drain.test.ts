import { afterEach, describe, expect, test } from "bun:test";
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

  test("draining until an empty batch reaches every settled row", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= 1_100; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: id <= BATCH_LIMIT ? null : `frame ${id}`,
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

    expect(collected).toHaveLength(601);
    expect(collected[0]).toBe(`frame:${BATCH_LIMIT + 1}`);
    expect(collected.at(-1)).toBe("transcription:1");
    await connector.revoke();
  });
});
