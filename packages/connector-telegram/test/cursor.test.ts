import { expect, test } from "bun:test";
import {
  MAX_DIALOGS,
  TELEGRAM_CURSOR_SCHEMA,
  encodeCursor,
  parseCursor,
} from "../src/cursor";
import type { TelegramCursor } from "../src/cursor";
import { TelegramConnectorError } from "../src/api";

const CURSOR: TelegramCursor = {
  schema: TELEGRAM_CURSOR_SCHEMA,
  dialogs: {
    "9": { peer_type: "user", last_id: 12, exhausted: false },
    "-42": { peer_type: "group", last_id: 3, exhausted: true },
    "-100777": { peer_type: "channel", last_id: 0, exhausted: false },
  },
  phase: "backfill",
  edit_watermark: 1767225600,
  pass: null,
};

function rejection(text: string): TelegramConnectorError {
  let thrown: unknown;
  try {
    parseCursor(text);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TelegramConnectorError);
  return thrown as TelegramConnectorError;
}

test("a cursor round-trips through encode and parse", () => {
  expect(parseCursor(encodeCursor(CURSOR))).toEqual(CURSOR);
});

test("an in-flight pass round-trips", () => {
  const withPass: TelegramCursor = {
    ...CURSOR,
    phase: "synced",
    pass: { started_at: 1767225600, next_peer: "-42" },
  };
  expect(parseCursor(encodeCursor(withPass))).toEqual(withPass);
});

test("encoding normalises dialog order", () => {
  const reordered: TelegramCursor = {
    ...CURSOR,
    dialogs: {
      "-42": { peer_type: "group", last_id: 3, exhausted: true },
      "9": { peer_type: "user", last_id: 12, exhausted: false },
      "-100777": { peer_type: "channel", last_id: 0, exhausted: false },
    },
  };
  expect(encodeCursor(reordered)).toBe(encodeCursor(CURSOR));
  const keys = Object.keys(
    (JSON.parse(encodeCursor(CURSOR)) as {
      dialogs: Record<string, unknown>;
    }).dialogs,
  );
  expect(keys.filter((key) => key.startsWith("-"))).toEqual([
    "-100777",
    "-42",
  ]);
});

test("a deviating cursor is a parse error", () => {
  const base = JSON.parse(encodeCursor(CURSOR)) as Record<string, unknown>;
  const variants: unknown[] = [
    { ...base, schema: "kizuki.telegram-cursor/v2" },
    { ...base, phase: "done" },
    { ...base, edit_watermark: -1 },
    { ...base, edit_watermark: 1.5 },
    { ...base, extra: true },
    { ...base, dialogs: { "9": { peer_type: "user", last_id: 1.5, exhausted: false } } },
    { ...base, dialogs: { "9": { peer_type: "secret", last_id: 1, exhausted: false } } },
    { ...base, dialogs: { "9": { peer_type: "user", last_id: 1 } } },
    { ...base, dialogs: { "9": { peer_type: "user", last_id: 1, exhausted: false, extra: 1 } } },
    { ...base, dialogs: { ada: { peer_type: "user", last_id: 1, exhausted: false } } },
    { ...base, dialogs: [] },
    { ...base, pass: { started_at: 1, next_peer: 9 } },
    { ...base, pass: { started_at: 1 } },
  ];
  for (const variant of variants) {
    expect(rejection(JSON.stringify(variant)).code).toBe("parse_error");
  }
  expect(rejection("not json").code).toBe("parse_error");
});

test("more dialogs than the listing bound is a parse error", () => {
  const dialogs: Record<string, unknown> = {};
  for (let index = 0; index <= MAX_DIALOGS; index += 1) {
    dialogs[String(index + 1)] = {
      peer_type: "user",
      last_id: 0,
      exhausted: false,
    };
  }
  expect(
    rejection(JSON.stringify({ ...CURSOR, dialogs })).code,
  ).toBe("parse_error");
});
