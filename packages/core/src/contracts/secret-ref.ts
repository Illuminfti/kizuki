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

const ENV_REF = /^env:([^\s]+)$/;
// File references carry literal path bytes. Only ASCII space is admitted in
// addition to the old non-whitespace alphabet; controls are forbidden.
const FILE_REF = /^file:((?:[^\s\x00-\x1f\x7f-\x9f]| )+)$/;

export function parseSecretRef(value: unknown): SecretRef | null {
  if (typeof value !== "string") return null;
  const env = ENV_REF.exec(value);
  if (env?.[1] !== undefined) return { scheme: "env", value: env[1] };
  const file = FILE_REF.exec(value);
  // `$` may match before a terminal newline; never trim or decode file paths.
  if (file?.[1] !== undefined && file[0] === value) return { scheme: "file", value: file[1] };
  return null;
}

export function isSecretRef(value: unknown): value is string {
  return parseSecretRef(value) !== null;
}
