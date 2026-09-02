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

test("nothing the corruption carries repeats the session", () => {
  // A rendered error shows its causes too, so `.message` alone is not the
  // boundary: the parser quotes the token it choked on, and in a state blob
  // that lost its quoting the token is the credential itself.
  const opaque = "AQBANOTEwODIzNDU2Nzg5MEFCQ0RFRg";
  const unquoted = `{"schema":"${TELEGRAM_STATE_SCHEMA}","session":${opaque}}`;
  const cases: [Uint8Array | string, string][] = [
    [unquoted, opaque],
    [new TextEncoder().encode(unquoted), opaque],
    [`{"schema":"${TELEGRAM_STATE_SCHEMA}","session":"${opaque}`, opaque],
    [JSON.stringify({ ...STATE, schema: "wrong" }), STATE.session],
  ];
  for (const [value, secret] of cases) {
    const error = corruption(value);
    expect(error.message).not.toContain(secret);
    expect(Bun.inspect(error, { depth: 10 })).not.toContain(secret);
    expect(rendered(error)).not.toContain(secret);
  }
});

/** Walks the cause chain the way a log line or a crash report would. */
function rendered(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    parts.push(current.name, current.message, current.stack ?? "");
    current = current.cause;
  }
  parts.push(String(current));
  return parts.join("\n");
}
