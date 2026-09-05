import { isPlainObject, isRfc3339 } from "@kizuki/core";
import { TelegramConnectorError, redactedCause } from "./api";

export const TELEGRAM_STATE_SCHEMA = "kizuki.telegram-state/v1" as const;

export interface TelegramState {
  schema: typeof TELEGRAM_STATE_SCHEMA;
  /** Telegram user id as a decimal string. */
  user_id: string;
  /** The credential. Never logged, hashed into a cursor, or put in a message. */
  session: string;
  /** Content-free provider cooldown, retained across process restarts. */
  retry_not_before?: string;
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
    Object.keys(value).some(key => ![...STATE_KEYS, "retry_not_before"].includes(key)) ||
    !STATE_KEYS.every((key) => Object.hasOwn(value, key)) ||
    value["schema"] !== TELEGRAM_STATE_SCHEMA ||
    typeof value["user_id"] !== "string" ||
    !/^[0-9]{1,20}$/.test(value["user_id"]) ||
    typeof value["session"] !== "string" ||
    value["session"].length === 0 ||
    (value["retry_not_before"] !== undefined && (!isRfc3339(value["retry_not_before"]) || !Number.isFinite(Date.parse(value["retry_not_before"])) ))
  ) {
    throw corruptState();
  }
  return {
    schema: TELEGRAM_STATE_SCHEMA,
    user_id: value["user_id"],
    session: value["session"],
    ...(value["retry_not_before"] === undefined ? {} : { retry_not_before: value["retry_not_before"] as string }),
  };
}

function corruptState(cause?: unknown): TelegramConnectorError {
  return new TelegramConnectorError(
    "corrupt_state",
    "kizuki.telegram: stored connection state is unreadable; sign in again",
    cause === undefined ? undefined : { cause: redactedCause(cause) },
  );
}

/** Reauthentication never repoints durable history to another account. */
export function assertSameTelegramIdentity(previous: Uint8Array, candidate: Uint8Array): void {
  if (parseState(previous).user_id !== parseState(candidate).user_id) {
    throw new TelegramConnectorError("identity_mismatch", "kizuki.telegram: replacement identity does not match the existing source");
  }
}
export function assertTelegramRetryAllowed(bytes: Uint8Array | string, now = Date.now()): void {
  const state = parseState(bytes);
  const until = state.retry_not_before === undefined ? 0 : Date.parse(state.retry_not_before);
  if (until > now) throw new TelegramConnectorError("flood_wait", "kizuki.telegram: wait before retrying this source", { retry_after: Math.ceil((until - now) / 1000) });
}
