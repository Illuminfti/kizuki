import { isRfc3339 } from "../util/time";
import { isNonEmptyString, isPlainObject } from "../util/validate";
import { OAuthError } from "./oauth-error";
import type { OAuthProvider } from "./provider-guard";

export interface TokenSet {
  access_token: string;
  refresh_token: string | null;
  /** RFC3339, computed from the provider's expires_in when the response parsed. */
  expires_at: string;
  /** The scope the owner granted, not the scope the provider was asked for. */
  scope: string;
  token_type: "Bearer";
}

export function bodyError(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const value = body["error"];
  return typeof value === "string" ? value : undefined;
}

/**
 * `previous` is the token set being refreshed. An omitted `refresh_token` or
 * `scope` keeps what it holds, so only a first exchange falls back to the
 * scopes the provider was asked for: a refresh must never record a wider
 * grant than the owner made on the consent screen.
 */
export function parseTokenResponse(
  provider: OAuthProvider,
  status: number,
  body: unknown,
  now: Date,
  previous?: TokenSet,
): TokenSet {
  if (status !== 200) {
    throw new OAuthError("provider_error", provider.name, bodyError(body));
  }
  const invalid = (): never => {
    throw new OAuthError("invalid_token_response", provider.name);
  };
  if (!isPlainObject(body)) return invalid();

  const accessToken = body["access_token"];
  if (!isNonEmptyString(accessToken)) return invalid();

  const tokenType = body["token_type"];
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    return invalid();
  }

  const expiresIn = body["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return invalid();
  }

  const rotated = body["refresh_token"];
  let refreshToken: string | null;
  // Only an absent field means "unchanged": an explicit null is a malformed
  // response, not a provider telling us to keep what we have.
  if (rotated === undefined) {
    refreshToken = previous?.refresh_token ?? null;
  } else if (isNonEmptyString(rotated)) {
    refreshToken = rotated;
  } else {
    return invalid();
  }

  const grantedScope = body["scope"];
  if (grantedScope !== undefined && typeof grantedScope !== "string") {
    return invalid();
  }

  // A lifetime past the ECMAScript time range would make toISOString throw,
  // and one merely past year 9999 makes it emit the expanded form the envelope
  // reader refuses; either way the durable state would be unreadable, so the
  // refusal belongs here rather than a process later.
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  if (Number.isNaN(expiresAt.getTime())) return invalid();
  const expiresAtText = expiresAt.toISOString();
  if (!isRfc3339(expiresAtText)) return invalid();

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAtText,
    // A refresh that omits the scope granted the same scope as before; falling
    // back to the requested scopes would record a grant the owner never made.
    scope: grantedScope ?? previous?.scope ?? provider.scopes.join(" "),
    token_type: "Bearer",
  };
}
