import { describe, expect, test } from "bun:test";
import {
  SCREENPIPE_CURSOR_SCHEMA,
  encodeCursor,
  initialCursor,
  parseCursor,
  replayFrom,
} from "../src/cursor";
import type { DatabaseIdentity } from "../src/identity";
import { ScreenpipeConnectorError } from "../src/errors";

const IDENTITY: DatabaseIdentity = {
  path: "/tmp/screenpipe-fixture.sqlite",
  fingerprint: "ab".repeat(32),
  max_frame_id: 8,
  max_transcription_id: 3,
};

describe("screenpipe cursor", () => {
  test("round trips ids, identity, phase and running skip counters", () => {
    const cursor = initialCursor(IDENTITY, { frame: 42, transcription: 17 });
    cursor.skipped.frames_without_text = 3;
    cursor.skipped.frames_bad_timestamp = 2;
    cursor.skipped.frames_offset_unknown = 1;
    cursor.skipped.transcriptions_bad_timestamp = 1;
    cursor.skipped.transcriptions_bad_offset = 4;
    cursor.skipped.transcriptions_offset_unknown = 1;
    cursor.oldest_skipped_frame_id = 7;
    cursor.phase = "caught_up";

    expect(parseCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  test("rejects wrong schema, extra keys, missing counters, negative ids, floats", () => {
    const valid = initialCursor(IDENTITY);
    const invalid: unknown[] = [
      { ...valid, schema: "kizuki.screenpipe-cursor/v1" },
      { ...valid, extra: true },
      {
        schema: SCREENPIPE_CURSOR_SCHEMA,
        last_frame_id: 0,
        last_transcription_id: 0,
        skipped: {
          frames_without_text: 0,
          frames_bad_timestamp: 0,
        },
      },
      { ...valid, last_frame_id: -1 },
      { ...valid, last_transcription_id: 1.5 },
      {
        ...valid,
        skipped: { ...valid.skipped, frames_bad_timestamp: -1 },
      },
      {
        ...valid,
        skipped: {
          ...valid.skipped,
          transcriptions_bad_timestamp: 0.25,
        },
      },
      { ...valid, phase: "done" },
      { ...valid, db_fingerprint: "not-hex" },
    ];

    for (const value of invalid) {
      expect(() => parseCursor(JSON.stringify(value))).toThrow(
        new ScreenpipeConnectorError(
          "parse_error",
          "kizuki.screenpipe: malformed cursor",
        ),
      );
    }
  });

  test("rejects non-JSON and non-object cursors", () => {
    for (const cursor of ["{", "null", "[]", '"cursor"']) {
      expect(() => parseCursor(cursor)).toThrow(
        "kizuki.screenpipe: malformed cursor",
      );
    }
  });

  test("rejects unsafe integer ids and counters", () => {
    const valid = initialCursor(IDENTITY);
    expect(() =>
      parseCursor(
        JSON.stringify({
          ...valid,
          last_frame_id: Number.MAX_SAFE_INTEGER + 1,
        }),
      ),
    ).toThrow("kizuki.screenpipe: malformed cursor");
    expect(() =>
      parseCursor(
        JSON.stringify({
          ...valid,
          skipped: {
            ...valid.skipped,
            frames_without_text: Number.MAX_SAFE_INTEGER + 1,
          },
        }),
      ),
    ).toThrow("kizuki.screenpipe: malformed cursor");
  });

  test("encoding is key-order stable", () => {
    expect(encodeCursor(initialCursor(IDENTITY))).toBe(
      JSON.stringify(initialCursor(IDENTITY)),
    );
  });

  test("replayFrom rewinds stream ids and resumes", () => {
    const cursor = initialCursor(IDENTITY, { frame: 8, transcription: 3 });
    cursor.phase = "exhausted";
    const replayed = replayFrom(cursor, { frame: 6 });
    expect(replayed.last_frame_id).toBe(6);
    expect(replayed.last_transcription_id).toBe(3);
    expect(replayed.phase).toBe("continue");
    expect(replayed.db_fingerprint).toBe(IDENTITY.fingerprint);
  });
});
