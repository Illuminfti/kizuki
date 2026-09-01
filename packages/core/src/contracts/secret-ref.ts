/**
 * The narrow URI grammar shared by connector manifests and the ledger.  This
 * is deliberately a reference grammar, not a resolver: values stay outside
 * SQLite and are resolved only by a trusted host at use time.
 */
export type SecretRefScheme = "env" | "file";

export interface SecretRef {
  scheme: SecretRefScheme;
  value: string;
}

const SECRET_REF = /^(env|file):([^\s]+)$/;

export function parseSecretRef(value: unknown): SecretRef | null {
  if (typeof value !== "string") return null;
  const match = SECRET_REF.exec(value);
  if (match === null) return null;
  const scheme = match[1];
  const reference = match[2];
  if (
    reference === undefined ||
    (scheme !== "env" && scheme !== "file")
  ) {
    return null;
  }
  return { scheme, value: reference };
}

export function isSecretRef(value: unknown): value is string {
  return parseSecretRef(value) !== null;
}
