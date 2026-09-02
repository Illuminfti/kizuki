export type OAuthErrorCode =
  | "timeout"
  | "state_mismatch"
  | "provider_error"
  | "invalid_token_response"
  | "transport"
  | "refresh_rejected"
  | "invalid_state"
  | "unauthenticated"
  | "not_supported";

/**
 * Carries a code, the provider label and at most a short sanitised detail.
 * Secrets are structurally excluded: nothing from a callback query, a token
 * response body or the PKCE material may reach `message`, so `String(error)`
 * and `JSON.stringify(error)` are safe to log.
 */
export class OAuthError extends Error {
  override name = "OAuthError";
  readonly code: OAuthErrorCode;
  readonly provider: string;
  /** The sanitised fragment in the message, kept so a relabel can carry it. */
  readonly detail: string | undefined;

  constructor(code: OAuthErrorCode, provider: string, detail?: string) {
    const safe = sanitizeDetail(detail);
    super(
      safe === undefined
        ? `${provider}: ${code}`
        : `${provider}: ${code}: ${safe}`,
    );
    this.code = code;
    this.provider = provider;
    this.detail = safe;
  }
}

const MAX_DETAIL_CHARS = 64;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * Only a short printable ASCII fragment of provider-controlled text may reach
 * an error message; everything else is dropped rather than truncated.
 */
function sanitizeDetail(detail: unknown): string | undefined {
  if (typeof detail !== "string") return undefined;
  if (detail.length === 0 || detail.length > MAX_DETAIL_CHARS) return undefined;
  return PRINTABLE_ASCII.test(detail) ? detail : undefined;
}

/**
 * A transport is a seam a provider package fills, and whatever it wrote into
 * its own error may be a URL, a fragment of the provider's answer or the
 * owner's private text. Only the name of the error crosses this line.
 */
export function transportError(error: unknown, provider: string): OAuthError {
  return new OAuthError(
    "transport",
    provider,
    error instanceof Error ? error.name : typeof error,
  );
}

/**
 * A failure raised inside this module already carries a sanitised detail;
 * callers branch on `OAuthError.provider`, so every error leaving the module
 * names the provider the caller asked for. Anything else is a transport's.
 */
export function asOAuthError(error: unknown, provider: string): OAuthError {
  if (error instanceof OAuthError) {
    return error.provider === provider
      ? error
      : new OAuthError(error.code, provider, error.detail);
  }
  return transportError(error, provider);
}

/**
 * Provider-controlled text may echo back the very secrets the request carried.
 * A detail holding one is dropped whole rather than truncated. The argument is
 * already normalised, so nothing an untrusted collaborator authored can leave
 * an operation by skipping this pass.
 */
export function withoutSecrets(
  error: OAuthError,
  secrets: readonly string[],
): OAuthError {
  for (const secret of secrets) {
    if (secret.length > 0 && error.message.includes(secret)) {
      return new OAuthError(error.code, error.provider);
    }
  }
  return error;
}
