import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  ScreenpipeConnector,
  ScreenpipeConnectorError,
  openReadOnly,
  parseCursor,
} from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
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

  test("a row dated before the cutoff is never emitted, whatever its id", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    // screenpipe stamps a transcription when it finishes transcribing, not when
    // the audio was captured, so id order is not timestamp order there in
    // ordinary operation. A seed alone therefore cannot enforce the cutoff.
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-02-01T00:00:00Z",
      fullText: "dated after the cutoff",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "dated before the cutoff",
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-02-02T00:00:00Z",
      transcription: "spoken after the cutoff",
    });
    insertTranscription(fixture.writer, {
      id: 2,
      timestamp: "2026-01-02T00:00:00Z",
      transcription: "spoken before the cutoff",
    });
    const connector = new ScreenpipeConnector(
      {
        path: fixture.path,
        since: "2026-01-15T00:00:00Z",
        settle_seconds: 0,
      },
      fixtureDeps("2026-03-01T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
      "transcription:1",
    ]);
    await connector.revoke();
  });

  test("a clock behind the source keeps the history the cutoff allows", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    for (const [id, timestamp] of [
      [1, "2026-03-01T12:00:00Z"],
      [2, "2026-03-01T12:30:00Z"],
      [3, "2026-03-01T13:00:00Z"],
    ] as const) {
      insertFrame(fixture.writer, { id, timestamp, fullText: `frame ${id}` });
    }
    // A host whose clock trails the capture machine sees every row dated ahead
    // of it. Seeding past them would discard the whole database, and the
    // persisted cursor would keep it discarded after the clock is corrected.
    const behind = new ScreenpipeConnector(
      {
        path: fixture.path,
        since: "2026-01-01T00:00:00Z",
        settle_seconds: 300,
      },
      fixtureDeps("2026-03-01T11:00:00.000Z"),
    );

    const batch = await behind.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:1",
      "frame:2",
      "frame:3",
    ]);
    await behind.revoke();
  });

  test("a row dated past the clock does not pull in the rows before the cutoff", async () => {
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

    // A clock step or a corrupt row can date an early row years ahead. Seeding
    // from it starts the walk at the head of the table, which is why the cutoff
    // is a predicate on every row: the rows before it stay out either way. The
    // skewed row itself is dated after the cutoff, so it is read like any other
    // row past the settle horizon.
    seedRows("2035-01-01T00:00:00Z");
    expect(await emitted()).toEqual(["frame:1", "frame:4", "frame:5"]);

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

  test("a timestamp that is not text is counted whether since is set or not", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    for (let id = 1; id <= 3; id += 1) {
      insertFrame(fixture.writer, {
        id,
        // The column is declared TIMESTAMP, which SQLite gives NUMERIC
        // affinity, so a restored dump can store a numeric-looking value.
        timestamp: 20_260_105,
        fullText: `frame ${id}`,
      });
    }
    const counted = async (since?: string): Promise<number> => {
      const connector = new ScreenpipeConnector(
        {
          path: fixture.path,
          settle_seconds: 0,
          ...(since === undefined ? {} : { since }),
        },
        fixtureDeps("2026-03-01T00:00:00.000Z"),
      );
      const batch = await connector.backfill(null);
      await connector.revoke();
      if (batch.cursor === null) throw new Error("expected a screenpipe cursor");
      return parseCursor(batch.cursor).skipped.frames_bad_timestamp;
    };

    // SQLite sorts every number before every string, so such a row can never
    // satisfy the cutoff comparison. Seeding past it hides it from the counter
    // that doctor reports while leaving it exactly as unread.
    expect(await counted("2026-01-01T00:00:00Z")).toBe(3);
    expect(await counted()).toBe(3);
  });

  test("a row written while the cutoff is being seeded is not skipped", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2020-01-01T00:00:00Z",
      fullText: "older than the cutoff",
    });
    let written = false;
    const concurrentWrite = (): void => {
      if (written) return;
      written = true;
      insertFrame(fixture.writer, {
        id: 2,
        timestamp: "2026-01-08T12:00:00Z",
        fullText: "written while the seed ran",
      });
    };
    const connector = new ScreenpipeConnector(
      {
        path: fixture.path,
        since: "2026-01-08T00:00:00Z",
        settle_seconds: 0,
      },
      fixtureDeps("2026-01-09T00:00:00.000Z", (databasePath) =>
        readerWritingMidSeed(openReadOnly(databasePath), concurrentWrite),
      ),
    );

    // screenpipe keeps recording while the seed runs, and this connector opens
    // no transaction. A fallback taken from a second statement would step over
    // the row that landed in between and nothing would ever come back for it.
    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual(
      ["frame:2"],
    );
    await connector.revoke();
  });
});

/**
 * A read handle that lets a writer land a row immediately after each seed
 * statement returns, which is the only moment a two-statement seed could lose
 * one.
 */
function readerWritingMidSeed(
  reader: Database,
  afterSeedStatement: () => void,
): Database {
  return new Proxy(reader, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (property !== "query" || typeof member !== "function") {
        return typeof member === "function" ? member.bind(target) : member;
      }
      return (sql: string): unknown => {
        const statement: object = Reflect.apply(member, target, [sql]);
        if (!sql.includes("MIN(")) return statement;
        return new Proxy(statement, {
          get(inner, innerProperty) {
            const value: unknown = Reflect.get(inner, innerProperty);
            if (innerProperty !== "get" || typeof value !== "function") {
              return typeof value === "function" ? value.bind(inner) : value;
            }
            return (...args: string[]): unknown => {
              const row: unknown = Reflect.apply(value, inner, args);
              afterSeedStatement();
              return row;
            };
          },
        });
      };
    },
  });
}
