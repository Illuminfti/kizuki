import { KizukiError } from "@kizuki/core";
import type { KizukiErrorCode } from "@kizuki/core";
import { stripControls } from "../text";

const MAX_DETAIL_CHARS = 200;
/**
 * Redaction runs over more text than the detail keeps: dropping a credential
 * shifts what follows it forward, so a match past the cap can still reach the
 * message once an earlier one is replaced.
 */
const MAX_SCAN_CHARS = 4_096;
const REDACTED = "[redacted]";
/**
 * A one- or two-character secret matches so much ordinary text that replacing
 * it would destroy the diagnosis; `leaks` refuses such a message outright.
 */
const MIN_REDACTABLE_CHARS = 3;

const CODE_MAP: Record<string, KizukiErrorCode> = {
  AUTHENTICATIONFAILED: "unauthenticated",
  AUTHORIZATIONFAILED: "unauthenticated",
  EXPIRED: "unauthenticated",
  PRIVACYREQUIRED: "unauthenticated",
  LIMIT: "rate_limited",
  INUSE: "rate_limited",
  UNAVAILABLE: "unreachable",
};

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The server chooses this text and may quote back what we sent it, so the
 * credentials are removed before the message becomes an error or a health
 * detail. Case is ignored: a provider that upper-cases the account name in its
 * refusal would otherwise walk straight past an exact-match filter.
 */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  const usable = [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_REDACTABLE_CHARS)
    .sort((a, b) => b.length - a.length);
  if (usable.length === 0) return text;
  const pattern = new RegExp(usable.map(escapeForPattern).join("|"), "gi");
  return text.replace(pattern, REDACTED);
}

/**
 * A response line is decoded as latin-1, so a credential a server echoes back
 * arrives with every UTF-8 byte as its own character. Both spellings have to
 * be filtered or a non-ASCII password leaves mangled but perfectly readable.
 */
export function secretSpellings(secret: string): string[] {
  let latin = "";
  for (const byte of new TextEncoder().encode(secret)) {
    latin += String.fromCharCode(byte);
  }
  return latin === secret ? [secret] : [secret, latin];
}

/**
 * The last gate. Whitespace and case are folded away first, so neither a
 * credential split across a wrapped line nor one echoed in another case can
 * ride out on a message the redaction pattern did not match.
 */
function leaks(text: string, secrets: readonly string[]): boolean {
  const squashed = text.toLowerCase().replace(/\s+/g, "");
  return secrets.some((secret) => {
    const needle = secret.toLowerCase().replace(/\s+/g, "");
    return needle.length > 0 && squashed.includes(needle);
  });
}

/** Server text is untrusted display data: no credentials, no control characters, bounded. */
export function sanitizeDetail(
  text: string,
  secrets: readonly string[] = [],
): string {
  const cleaned = redactSecrets(
    stripControls(text, MAX_SCAN_CHARS),
    secrets,
  );
  const capped = Array.from(cleaned).slice(0, MAX_DETAIL_CHARS).join("");
  // A secret that survived both passes means the server encoded it in a shape
  // this code does not model; the whole message goes rather than the credential.
  return leaks(capped, secrets) ? "" : capped;
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
  options: { login: boolean; secrets?: readonly string[] },
): KizukiError {
  const code = responseCode(text);
  const mapped = code === null ? undefined : CODE_MAP[code];
  // Only a LOGIN refused without any response code is a credential verdict.
  // A server fault carrying an unmapped code during LOGIN is a fault, and
  // telling the owner their password is wrong would send them the wrong way.
  const fallback =
    code === null && options.login ? "unauthenticated" : "protocol";
  const detail = sanitizeDetail(text, options.secrets ?? []);
  return new KizukiError(
    mapped ?? fallback,
    detail.length > 0 ? detail : "server refused the command",
  );
}
