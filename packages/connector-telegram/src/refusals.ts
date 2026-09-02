import { TelegramConnectorError, redactedCause } from "./api";

/**
 * The refusals this connector raises on its own, without asking Telegram
 * anything. They are what "fail closed" looks like from a caller's side: an
 * instance with no session, no live client, or none left to it says so rather
 * than reaching for a connection it has no right to.
 */

export function notSignedIn(cause?: unknown): TelegramConnectorError {
  return new TelegramConnectorError(
    "missing_session",
    "kizuki.telegram: not signed in; run: kizuki connect telegram",
    cause === undefined ? undefined : { cause: redactedCause(cause) },
  );
}

export function revoked(): TelegramConnectorError {
  return new TelegramConnectorError(
    "unauthenticated",
    "kizuki.telegram: access was revoked; sign in again",
  );
}

export function notConnected(): TelegramConnectorError {
  return new TelegramConnectorError(
    "missing_session",
    "kizuki.telegram: connect() has not been called",
  );
}
