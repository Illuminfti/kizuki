import { KizukiError } from "@kizuki/core";
import type { KizukiErrorCode } from "@kizuki/core";

const MAX_DETAIL_CHARS = 200;

const CODE_MAP: Record<string, KizukiErrorCode> = {
  AUTHENTICATIONFAILED: "unauthenticated",
  AUTHORIZATIONFAILED: "unauthenticated",
  EXPIRED: "unauthenticated",
  PRIVACYREQUIRED: "unauthenticated",
  LIMIT: "rate_limited",
  INUSE: "rate_limited",
  UNAVAILABLE: "unreachable",
};

/** Server text is untrusted display data: no control characters, bounded. */
export function sanitizeDetail(text: string): string {
  const stripped = Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  return stripped.length > MAX_DETAIL_CHARS
    ? stripped.slice(0, MAX_DETAIL_CHARS)
    : stripped;
}

export function responseCode(text: string): string | null {
  const match = /^\[([A-Za-z0-9-]+)(?:\s[^\]]*)?\]/.exec(text.trim());
  return match === null ? null : (match[1] ?? "").toUpperCase();
}

/**
 * Maps a tagged failure to the one error type the host understands. The
 * command that failed is never named: a LOGIN line carries the app password.
 */
export function failureFor(
  text: string,
  options: { login: boolean },
): KizukiError {
  const code = responseCode(text);
  const mapped = code === null ? undefined : CODE_MAP[code];
  // Only a LOGIN refused without any response code is a credential verdict.
  // A server fault carrying an unmapped code during LOGIN is a fault, and
  // telling the owner their password is wrong would send them the wrong way.
  const fallback =
    code === null && options.login ? "unauthenticated" : "protocol";
  const detail = sanitizeDetail(text);
  return new KizukiError(
    mapped ?? fallback,
    detail.length > 0 ? detail : "server refused the command",
  );
}
