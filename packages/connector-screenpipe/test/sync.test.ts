import { afterEach, describe, expect, test } from "bun:test";
import { ScreenpipeConnector } from "../src";
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

  test("a caught-up sync returns an empty batch with the same cursor", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const initial = await connector.sync(null);
    const caughtUp = await connector.sync(initial.cursor);

    expect(caughtUp).toEqual({ events: [], cursor: initial.cursor });
    await connector.revoke();
  });

  test("sync never returns a null cursor", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    expect((await connector.sync(null)).cursor).not.toBeNull();
    await connector.revoke();
  });
});
