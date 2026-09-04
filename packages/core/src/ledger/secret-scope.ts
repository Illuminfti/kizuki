import type { SecretResolver } from "../contracts/connector";
import { isSecretRef } from "../contracts/secret-ref";
import { LedgerError } from "./connections";

/**
 * A resolver that can name only the refs this connection was enrolled with.
 * The host still performs the actual read; this is the capability boundary.
 */
export function scopedSecretResolver(
  allowed: readonly string[],
  resolve: SecretResolver,
): SecretResolver {
  const allow = new Set(allowed);
  return async (secret_ref: string): Promise<string> => {
    if (!isSecretRef(secret_ref)) {
      throw new LedgerError("secret_ref is not a supported reference");
    }
    if (!allow.has(secret_ref)) {
      throw new LedgerError("secret_ref is not granted to this connection");
    }
    return resolve(secret_ref);
  };
}
