import { isPlainObject } from "@kizuki/core";
import { TelegramConnectorError } from "./api";

export const TELEGRAM_STATE_SCHEMA = "kizuki.telegram-state/v1" as const;

export interface TelegramState {
  schema: typeof TELEGRAM_STATE_SCHEMA;
  /** Telegram user id as a decimal string. */
  user_id: string;
  /** The credential. Never logged, hashed into a cursor, or put in a message. */
  session: string;
}

const STATE_KEYS = ["schema", "user_id", "session"] as const;

export function encodeState(state: TelegramState): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(checked(state)));
}

export function parseState(bytes: Uint8Array | string): TelegramState {
  let text: string;
  if (typeof bytes === "string") {
    text = bytes;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw corruptState(error);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw corruptState(error);
  }
  return checked(parsed);
}

function checked(value: unknown): TelegramState {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== STATE_KEYS.length ||
    !STATE_KEYS.every((key) => Object.hasOwn(value, key)) ||
    value["schema"] !== TELEGRAM_STATE_SCHEMA ||
    typeof value["user_id"] !== "string" ||
    !/^[0-9]{1,20}$/.test(value["user_id"]) ||
    typeof value["session"] !== "string" ||
    value["session"].length === 0
  ) {
    throw corruptState();
  }
  return {
    schema: TELEGRAM_STATE_SCHEMA,
    user_id: value["user_id"],
    session: value["session"],
  };
}

function corruptState(cause?: unknown): TelegramConnectorError {
  return new TelegramConnectorError(
    "corrupt_state",
    "kizuki.telegram: stored connection state is unreadable; sign in again",
    cause === undefined ? undefined : { cause },
  );
}
