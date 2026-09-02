import { expect, test } from "bun:test";
import { TELEGRAM_STATE_SCHEMA, encodeState, parseState } from "../src/state";
import { TelegramConnectorError } from "../src/api";

const STATE = {
  schema: TELEGRAM_STATE_SCHEMA,
  user_id: "1001",
  session: "fixture-session-token-not-a-real-credential",
} as const;

function corruption(value: Uint8Array | string): TelegramConnectorError {
  let thrown: unknown;
  try {
    parseState(value);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TelegramConnectorError);
  return thrown as TelegramConnectorError;
}

test("state round-trips through UTF-8 JSON bytes", () => {
  const bytes = encodeState(STATE);
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(parseState(bytes)).toEqual(STATE);
  expect(parseState(new TextDecoder().decode(bytes))).toEqual(STATE);
});

test("anything but a well-formed blob is corrupt state", () => {
  for (const value of [
    "",
    "not json",
    JSON.stringify({ ...STATE, schema: "kizuki.telegram-state/v2" }),
    JSON.stringify({ ...STATE, user_id: "ada" }),
    JSON.stringify({ ...STATE, session: "" }),
    JSON.stringify({ ...STATE, extra: 1 }),
    JSON.stringify([STATE]),
    JSON.stringify({ schema: TELEGRAM_STATE_SCHEMA, user_id: "1001" }),
  ]) {
    expect(corruption(value).code).toBe("corrupt_state");
  }
  expect(corruption(new Uint8Array([0xff, 0xfe, 0xfd])).code).toBe(
    "corrupt_state",
  );
});

test("the corruption message never repeats the session", () => {
  const message = corruption(
    JSON.stringify({ ...STATE, schema: "wrong" }),
  ).message;
  expect(message).not.toContain(STATE.session);
});
