import { expect, test } from "bun:test";
import {
  MAX_DIALOGS,
  TELEGRAM_CURSOR_SCHEMA,
  decodeDialogs,
  digestDialogs,
  encodeCursor,
  encodeDialog,
  parseCursor,
} from "../src/cursor";
import type { DialogCursor, TelegramCursor } from "../src/cursor";
import { TelegramConnectorError } from "../src/api";
import { MAX_CURSOR_BYTES } from "@kizuki/core";

const DIALOGS: Record<string, DialogCursor> = {
  "9": { peer_type: "user", last_id: 12, exhausted: false },
  "-42": { peer_type: "group", last_id: 3, exhausted: true },
  "-100777": { peer_type: "channel", last_id: 0, exhausted: false },
};

const CURSOR: TelegramCursor = {
  schema: TELEGRAM_CURSOR_SCHEMA,
  phase: "backfill",
  edit_watermark: 1767225600,
  pass: null,
  map_digest: digestDialogs(DIALOGS),
  legacy_dialogs: null,
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

test("the wire cursor does not grow with the account", () => {
  const dialogs: Record<string, DialogCursor> = {};
  for (let index = 0; index < MAX_DIALOGS; index += 1) {
    dialogs[String(100_000_000 + index)] = {
      peer_type: "user",
      last_id: 1_000_000,
      exhausted: false,
    };
  }
  const wire = encodeCursor({ ...CURSOR, map_digest: digestDialogs(dialogs) });
  expect(wire.length).toBeLessThan(300);
  expect(wire.length).toBeLessThan(MAX_CURSOR_BYTES);
});

test("the digest names the map, not the order it was built in", () => {
  const reordered: Record<string, DialogCursor> = {
    "-100777": DIALOGS["-100777"]!,
    "-42": DIALOGS["-42"]!,
    "9": DIALOGS["9"]!,
  };
  expect(digestDialogs(reordered)).toBe(digestDialogs(DIALOGS));
  expect(
    digestDialogs({ ...DIALOGS, "9": { ...DIALOGS["9"]!, last_id: 13 } }),
  ).not.toBe(digestDialogs(DIALOGS));
  expect(
    digestDialogs({
      ...DIALOGS,
      "-42": { ...DIALOGS["-42"]!, exhausted: false },
    }),
  ).not.toBe(digestDialogs(DIALOGS));
});

test("dialogs round-trip through the host store's text form", () => {
  const store = new Map(
    Object.entries(DIALOGS).map(([peer, dialog]) => [
      peer,
      encodeDialog(dialog),
    ]),
  );
  expect(store.get("9")).toBe("user:12:0");
  expect(decodeDialogs(store)).toEqual(DIALOGS);
});

test("a store entry that deviates is a parse error", () => {
  for (const [peer, value] of [
    ["9", "user:1.5:0"],
    ["9", "secret:1:0"],
    ["9", "user:1"],
    ["9", "user:1:2"],
    ["9", "user:-1:0"],
    ["9", "user:1:0:extra"],
    ["9", "user:99999999999999999999:0"],
    ["ada", "user:1:0"],
    ["", "user:1:0"],
  ] as const) {
    let thrown: unknown;
    try {
      decodeDialogs(new Map([[peer, value]]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TelegramConnectorError);
    expect((thrown as TelegramConnectorError).code).toBe("parse_error");
  }
});

test("more dialogs than the listing bound is a parse error", () => {
  const store = new Map<string, string>();
  for (let index = 0; index <= MAX_DIALOGS; index += 1) {
    store.set(String(index + 1), "user:0:0");
  }
  expect(() => decodeDialogs(store)).toThrow(TelegramConnectorError);
});

test("a deviating cursor is a parse error", () => {
  const base = JSON.parse(encodeCursor(CURSOR)) as Record<string, unknown>;
  const variants: unknown[] = [
    { ...base, schema: "kizuki.telegram-cursor/v3" },
    { ...base, phase: "done" },
    { ...base, edit_watermark: -1 },
    { ...base, edit_watermark: 1.5 },
    { ...base, extra: true },
    { ...base, map_digest: "abc" },
    { ...base, map_digest: undefined },
    { ...base, map_digest: CURSOR.map_digest.toUpperCase() },
    { ...base, dialogs: DIALOGS },
    { ...base, pass: { started_at: 1, next_peer: 9 } },
    { ...base, pass: { started_at: 1 } },
  ];
  for (const variant of variants) {
    expect(rejection(JSON.stringify(variant)).code).toBe("parse_error");
  }
  expect(rejection("not json").code).toBe("parse_error");
  expect(rejection("[]").code).toBe("parse_error");
});

const LEGACY = {
  schema: "kizuki.telegram-cursor/v1",
  dialogs: DIALOGS,
  phase: "backfill",
  edit_watermark: 1767225600,
  pass: null,
};

test("a cursor from before the host store still reads, carrying its dialogs once", () => {
  const parsed = parseCursor(JSON.stringify(LEGACY));
  expect(parsed.schema).toBe(TELEGRAM_CURSOR_SCHEMA);
  expect(parsed.legacy_dialogs).toEqual(DIALOGS);
  expect(parsed.phase).toBe("backfill");
  // Re-encoding moves the dialogs off the wire.
  expect(
    JSON.parse(
      encodeCursor({
        ...parsed,
        map_digest: digestDialogs(DIALOGS),
        legacy_dialogs: null,
      }),
    ),
  ).not.toHaveProperty("dialogs");
});

test("a deviating legacy cursor is a parse error", () => {
  const variants: unknown[] = [
    {
      ...LEGACY,
      dialogs: { "9": { peer_type: "user", last_id: 1.5, exhausted: false } },
    },
    {
      ...LEGACY,
      dialogs: { "9": { peer_type: "secret", last_id: 1, exhausted: false } },
    },
    { ...LEGACY, dialogs: { "9": { peer_type: "user", last_id: 1 } } },
    {
      ...LEGACY,
      dialogs: {
        "9": { peer_type: "user", last_id: 1, exhausted: false, extra: 1 },
      },
    },
    {
      ...LEGACY,
      dialogs: { ada: { peer_type: "user", last_id: 1, exhausted: false } },
    },
    { ...LEGACY, dialogs: [] },
    { ...LEGACY, map_digest: CURSOR.map_digest },
  ];
  for (const variant of variants) {
    expect(rejection(JSON.stringify(variant)).code).toBe("parse_error");
  }
  const dialogs: Record<string, unknown> = {};
  for (let index = 0; index <= MAX_DIALOGS; index += 1) {
    dialogs[String(index + 1)] = {
      peer_type: "user",
      last_id: 0,
      exhausted: false,
    };
  }
  expect(rejection(JSON.stringify({ ...LEGACY, dialogs })).code).toBe(
    "parse_error",
  );
});
