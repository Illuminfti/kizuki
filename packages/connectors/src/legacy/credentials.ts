/**
 * Field and column names that read as a credential.
 *
 * The ledger is append-only: a token copied into an event's metadata cannot be
 * edited out later, only purged with a receipt, and it travels from there into
 * proposals, reports and canon. Invariant 9 says a plaintext credential never
 * reaches SQLite, a log, a fixture or Markdown, so both importers drop the
 * value before the event is built and carry the name instead — the owner still
 * learns the field was there and what the estate called it.
 *
 * By name, never by value: this is not secret detection. A field the estate
 * merely called `api_key` is dropped whether or not it held one, because
 * guessing from the value is exactly the judgement that fails open.
 */

/** A word that names a credential on its own. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "mnemonic",
  "otp",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "pwd",
  "secret",
  "token",
]);

/** A word that makes the word after it a credential rather than an ordinary one. */
const SECRET_QUALIFIERS: ReadonlySet<string> = new Set([
  "access",
  "api",
  "auth",
  "client",
  "encryption",
  "master",
  "private",
  "refresh",
  "service",
  "session",
  "signing",
]);

/** What a qualifier qualifies: `public key` stays, `signing key` does not. */
const SECRET_HEADS: ReadonlySet<string> = new Set(["key", "secret", "token"]);

/**
 * The words in a field name. Estates write them every way there is —
 * `api_key`, `apiKey`, `API-KEY`, `x.auth.token` — so separators and
 * camel-case boundaries both count, and the comparison is on the compatibility
 * normalisation so a full-width letter is the letter it looks like.
 */
export function nameWords(key: string): string[] {
  return key
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

export function isCredentialName(key: string): boolean {
  const words = nameWords(key);
  for (const [index, word] of words.entries()) {
    if (SECRET_WORDS.has(word)) return true;
    const next = words[index + 1];
    if (
      next !== undefined &&
      SECRET_QUALIFIERS.has(word) &&
      SECRET_HEADS.has(next)
    ) {
      return true;
    }
  }
  return false;
}

/** The same bag in the same order, minus every credential-named entry. */
export function withoutCredentials(data: Record<string, unknown>): {
  data: Record<string, unknown>;
  redacted: string[];
} {
  const kept: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (isCredentialName(key)) {
      redacted.push(key);
      continue;
    }
    // Defined rather than assigned: a key named after an Object member is
    // still data, and the estate that wrote it keeps it.
    Object.defineProperty(kept, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return redacted.length === 0 ? { data, redacted } : { data: kept, redacted };
}
