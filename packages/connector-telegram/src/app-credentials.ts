import { TelegramConnectorError } from "./api";
import type { AppCredentials } from "./api";

/**
 * Literal member expressions at module top level: that exact shape is what the
 * release build substitutes, name by name, through `Bun.build`'s `define`
 * (see `scripts/build-release.ts`). Reading through an indirection defeats the
 * substitution, and a build that compiled neither in leaves these two lines
 * reading the live environment.
 */
const COMPILED_API_ID: string = process.env.KIZUKI_TELEGRAM_API_ID ?? "0";
const COMPILED_API_HASH: string = process.env.KIZUKI_TELEGRAM_API_HASH ?? "";

export const PLACEHOLDER_CREDENTIALS_MESSAGE =
  "kizuki.telegram: app credentials are not compiled in; build with KIZUKI_TELEGRAM_API_ID and KIZUKI_TELEGRAM_API_HASH set (see packages/connector-telegram/README.md)";

/** `null` when either value is still a placeholder; `source` exists for tests only. */
export function appCredentials(
  source: { api_id: string; api_hash: string } = {
    api_id: COMPILED_API_ID,
    api_hash: COMPILED_API_HASH,
  },
): AppCredentials | null {
  if (typeof source.api_hash !== "string" || source.api_hash.trim().length === 0) {
    return null;
  }
  if (typeof source.api_id !== "string" || !/^[1-9][0-9]*$/.test(source.api_id)) {
    return null;
  }
  const id = Number(source.api_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { api_id: id, api_hash: source.api_hash };
}

/** Fails closed: no fallback credentials, and no prompt asking the owner for an app id. */
export function requireAppCredentials(
  credentials: () => AppCredentials | null,
): AppCredentials {
  const resolved = credentials();
  if (resolved === null) {
    throw new TelegramConnectorError(
      "placeholder_credentials",
      PLACEHOLDER_CREDENTIALS_MESSAGE,
    );
  }
  return resolved;
}
