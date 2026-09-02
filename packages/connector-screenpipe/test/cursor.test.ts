import { describe, expect, test } from "bun:test";
import {
  SCREENPIPE_CURSOR_SCHEMA,
  encodeCursor,
  initialCursor,
  parseCursor,
} from "../src/cursor";
import { ScreenpipeConnectorError } from "../src/errors";

describe("screenpipe cursor", () => {
  test("round trips both ids and running skip counters", () => {
    const cursor = initialCursor({ frame: 42, transcription: 17 });
    cursor.skipped.frames_without_text = 3;
    cursor.skipped.frames_bad_timestamp = 2;
    cursor.skipped.transcriptions_bad_timestamp = 1;

    expect(parseCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  test("rejects wrong schema, extra keys, missing counters, negative ids, floats", () => {
    const valid = initialCursor();
    const invalid: unknown[] = [
      { ...valid, schema: "kizuki.screenpipe-cursor/v2" },
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
    const valid = initialCursor();
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
    expect(encodeCursor(initialCursor())).toBe(
      '{"schema":"kizuki.screenpipe-cursor/v1","last_frame_id":0,"last_transcription_id":0,"skipped":{"frames_without_text":0,"frames_bad_timestamp":0,"transcriptions_bad_timestamp":0}}',
    );
  });
});
