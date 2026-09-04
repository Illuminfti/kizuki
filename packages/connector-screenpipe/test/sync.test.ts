import { afterEach, describe, expect, test } from "bun:test";
import { ScreenpipeConnector, parseCursor } from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

describe("ScreenpipeConnector sync", () => {
  test("sync(null) equals backfill(null)", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    expect(await connector.sync(null)).toEqual(await connector.backfill(null));
    await connector.revoke();
  });

  test("sync continues from the checkpoint and sees rows appended by a concurrent writer", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const initial = await connector.backfill(null);

    insertFrame(fixture.writer, {
      id: 9,
      timestamp: "2026-01-08T00:00:00Z",
      fullText: "newly appended text",
    });
    const next = await connector.sync(initial.cursor);

    expect(next.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:9",
    ]);
    expect(next.events[0]?.text).toBe("newly appended text");
    await connector.revoke();
  });

  test("a caught-up live tail returns an empty batch and keeps the high-water cursor", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const initial = await connector.sync(null);
    const caughtUp = await connector.sync(initial.cursor);

    expect(caughtUp.events).toEqual([]);
    expect(caughtUp.cursor).toBe(initial.cursor);
    if (caughtUp.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(caughtUp.cursor).phase).toBe("exhausted");
    await connector.revoke();
  });

  test("an empty database is exhausted, not a null cursor, so the high-water mark survives", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.sync(null);
    expect(batch.cursor).not.toBeNull();
    if (batch.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(batch.cursor).phase).toBe("exhausted");
    await connector.revoke();
  });
});
