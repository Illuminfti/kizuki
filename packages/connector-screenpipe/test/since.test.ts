import { afterEach, describe, expect, test } from "bun:test";
import { ScreenpipeConnector, ScreenpipeConnectorError } from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

describe("ScreenpipeConnector since", () => {
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

  test("a legacy timestamp after the cutoff keeps the rows before it", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= 24; id += 1) {
        insertFrame(fixture.writer, {
          id,
          // sqlx wrote a space between date and time before it moved to
          // RFC3339, and a space sorts before "T" in a textual comparison.
          timestamp:
            id === 21
              ? "2026-01-06 23:00:00"
              : `2026-01-06T${String(id % 24).padStart(2, "0")}:00:00Z`,
          fullText: `frame ${id}`,
        });
      }
    })();
    const connector = new ScreenpipeConnector(
      {
        path: fixture.path,
        since: "2026-01-06T00:00:00Z",
        settle_seconds: 0,
      },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual(
      Array.from({ length: 24 }, (_, index) => `frame:${index + 1}`),
    );
    await connector.revoke();
  });

  test("a row dated past the clock does not drag the seed to the head", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    const seedRows = (firstTimestamp: string): void => {
      fixture.writer.query("DELETE FROM frames").run();
      for (const [id, timestamp] of [
        [1, firstTimestamp],
        [2, "2026-05-02T00:00:00Z"],
        [3, "2026-05-03T00:00:00Z"],
        [4, "2026-06-02T00:00:00Z"],
        [5, "2026-06-03T00:00:00Z"],
      ] as const) {
        insertFrame(fixture.writer, { id, timestamp, fullText: `frame ${id}` });
      }
    };
    const emitted = async (): Promise<string[]> => {
      const connector = new ScreenpipeConnector(
        {
          path: fixture.path,
          since: "2026-06-01T00:00:00Z",
          settle_seconds: 0,
        },
        fixtureDeps("2026-08-01T00:00:00.000Z"),
      );
      const batch = await connector.backfill(null);
      await connector.revoke();
      return batch.events.map(({ source_record_id }) => source_record_id);
    };

    seedRows("2026-05-01T00:00:00Z");
    expect(await emitted()).toEqual(["frame:4", "frame:5"]);

    // A clock step or a corrupt row can date an early row years ahead. Such a
    // row sorts after the cutoff under both encodings, and seeding from it
    // would import the whole table the owner asked to skip.
    seedRows("2035-01-01T00:00:00Z");
    expect(await emitted()).toEqual(["frame:4", "frame:5"]);

    seedRows("yesterday");
    expect(await emitted()).toEqual(["frame:4", "frame:5"]);
  });

  test("a since the runtime cannot represent is refused up front", async () => {
    const fixture = createFixtureDatabase();

    try {
      new ScreenpipeConnector({
        path: fixture.path,
        // RFC3339 permits the leap second; the runtime has no date for it.
        since: "2026-06-30T23:59:60Z",
      });
      throw new Error("expected the leap second to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenpipeConnectorError);
      if (error instanceof ScreenpipeConnectorError) {
        expect(error.code).toBe("misconfigured");
      }
    }

    const usable = new ScreenpipeConnector(
      { path: fixture.path, since: "2026-01-05T09:00:01Z", settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    expect((await usable.backfill(null)).events.length).toBeGreaterThan(0);
    await usable.revoke();
  });
});
