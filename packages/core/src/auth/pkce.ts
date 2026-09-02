export interface Pkce {
  verifier: string;
  challenge: string;
}

const VERIFIER_BYTES = 32;

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function randomOf(
  randomBytes: (length: number) => Uint8Array,
  length: number,
): Uint8Array {
  const bytes = randomBytes(length);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw new TypeError(`randomBytes must return ${length} bytes`);
  }
  return bytes;
}

export function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** base64url(SHA-256(ASCII(verifier))) — RFC 7636 section 4.2. */
export function pkceChallenge(verifier: string): string {
  return base64url(
    new Uint8Array(new Bun.CryptoHasher("sha256").update(verifier).digest()),
  );
}

/** 32 random bytes to a base64url verifier (43 chars); challenge = S256. */
export function buildPkce(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): Pkce {
  const verifier = base64url(randomOf(randomBytes, VERIFIER_BYTES));
  return { verifier, challenge: pkceChallenge(verifier) };
}
