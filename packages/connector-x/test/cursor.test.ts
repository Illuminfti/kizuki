import { expect, test } from "bun:test";
import { MAX_CURSOR_BYTES } from "@kizuki/core";
import { X_ARCHIVE_CURSOR_SCHEMA, encodeCursor, parseCursor } from "../src";

test("X archive cursor round trips its bounded source checkpoint", () => {
  const cursor = {
    schema: X_ARCHIVE_CURSOR_SCHEMA,
    account_id: "123",
    snapshot_sha256: "a".repeat(64),
    next_part: 2,
    next_record: 40,
    seen_records: 1040,
  } as const;
  expect(parseCursor(encodeCursor(cursor))).toEqual(cursor);
});

test("X archive cursor refuses oversized and inconsistent shapes", () => {
  expect(() => parseCursor(`{"padding":"${"x".repeat(MAX_CURSOR_BYTES)}"}`))
    .toThrow("cursor is malformed");
  expect(() => parseCursor(JSON.stringify({
    schema: X_ARCHIVE_CURSOR_SCHEMA,
    account_id: "123",
    snapshot_sha256: "a".repeat(64),
    next_part: null,
    next_record: 0,
    seen_records: 1,
  }))).toThrow("cursor is malformed");
});
