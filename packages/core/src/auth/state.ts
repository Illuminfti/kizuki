import { isNonEmptyString, isPlainObject } from "../util/validate";
import { isRfc3339 } from "../util/time";
import { MAX_CONNECTION_STATE_BYTES } from "../ledger/connection-state";
import { OAuthError, type TokenSet } from "./oauth";

export const OAUTH_STATE_SCHEMA = "kizuki.oauth-state/v1" as const;

export interface OAuthState {
  schema: typeof OAUTH_STATE_SCHEMA;
  provider: string;
  /** Provider-stable account id plus the human label the owner recognises. */
  account: { id: string; display: string };
  tokens: TokenSet;
  written_at: string;
}

const STATE_KEYS = ["schema", "provider", "account", "tokens", "written_at"];
const ACCOUNT_KEYS = ["id", "display"];
const TOKEN_KEYS = [
  "access_token",
  "refresh_token",
  "expires_at",
  "scope",
  "token_type",
];

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const present = Object.keys(value);
  return (
    present.length === keys.length && keys.every((key) => key in value)
  );
}

/** UTF-8 JSON with a fixed key order, so an unchanged envelope encodes byte-identically. */
export function encodeOAuthState(state: OAuthState): Uint8Array {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      schema: state.schema,
      provider: state.provider,
      account: { id: state.account.id, display: state.account.display },
      tokens: {
        access_token: state.tokens.access_token,
        refresh_token: state.tokens.refresh_token,
        expires_at: state.tokens.expires_at,
        scope: state.tokens.scope,
        token_type: state.tokens.token_type,
      },
      written_at: state.written_at,
    }),
  );
  if (bytes.byteLength > MAX_CONNECTION_STATE_BYTES) {
    throw new RangeError("oauth state exceeds the maximum connection state size");
  }
  // The one writer of durable connection state must not emit bytes its own
  // reader refuses: that connection is dead from the next process on, and only
  // a fresh sign-in can revive it. Reading the bytes back is what keeps the two
  // ends from drifting apart.
  parseOAuthState(bytes, state.provider);
  return bytes;
}

function parseTokens(source: unknown, provider: string): TokenSet {
  const invalid = (): never => {
    throw new OAuthError("invalid_state", provider);
  };
  if (!isPlainObject(source) || !hasExactKeys(source, TOKEN_KEYS)) {
    return invalid();
  }
  const accessToken = source["access_token"];
  const refreshToken = source["refresh_token"];
  const expiresAt = source["expires_at"];
  const scope = source["scope"];
  const tokenType = source["token_type"];
  if (!isNonEmptyString(accessToken)) return invalid();
  if (refreshToken !== null && !isNonEmptyString(refreshToken)) return invalid();
  if (!isRfc3339(expiresAt)) return invalid();
  if (typeof scope !== "string") return invalid();
  if (tokenType !== "Bearer") return invalid();
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    scope,
    token_type: tokenType,
  };
}

/**
 * Fails closed on anything that is not exactly this envelope for exactly this
 * provider: state that does not parse is state the connector must not act on.
 */
export function parseOAuthState(
  source: Uint8Array | string,
  provider: string,
): OAuthState {
  const invalid = (): never => {
    throw new OAuthError("invalid_state", provider);
  };
  if (!isNonEmptyString(provider)) return invalid();
  let text: string;
  if (typeof source === "string") {
    text = source;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      return invalid();
    }
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!isPlainObject(document) || !hasExactKeys(document, STATE_KEYS)) {
    return invalid();
  }
  if (document["schema"] !== OAUTH_STATE_SCHEMA) return invalid();
  if (document["provider"] !== provider) return invalid();

  const account = document["account"];
  if (!isPlainObject(account) || !hasExactKeys(account, ACCOUNT_KEYS)) {
    return invalid();
  }
  const id = account["id"];
  const display = account["display"];
  if (!isNonEmptyString(id) || !isNonEmptyString(display)) return invalid();

  const writtenAt = document["written_at"];
  if (!isRfc3339(writtenAt)) return invalid();

  return {
    schema: OAUTH_STATE_SCHEMA,
    provider,
    account: { id, display },
    tokens: parseTokens(document["tokens"], provider),
    written_at: writtenAt,
  };
}
