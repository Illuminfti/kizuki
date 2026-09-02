import { afterEach, describe, expect, test } from "bun:test";
import { ScreenpipeConnector } from "../src";
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
});
