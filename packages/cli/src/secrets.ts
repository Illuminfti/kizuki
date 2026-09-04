import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseSecretRef, scopedSecretResolver } from "@kizuki/core";
import type { SecretResolver } from "@kizuki/core";

const MAX_SECRET_BYTES = 16_384;

export function validTokenRef(ref: string): boolean {
  const parsed = parseSecretRef(ref);
  return parsed !== null && (parsed.scheme === "env"
    ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.value)
    : isAbsolute(parsed.value));
}

/** Only the reference explicitly enrolled for this connection may be resolved. */
export function tokenResolver(
  ref: string,
  env: Record<string, string | undefined>,
): SecretResolver {
  return scopedSecretResolver([ref], async () => {
    const parsed = parseSecretRef(ref);
    if (parsed === null || !validTokenRef(ref)) {
      throw new Error("Use --token-ref env:VAR or file:/absolute/path.");
    }
    let value: string | undefined;
    if (parsed.scheme === "env") {
      value = env[parsed.value];
    } else {
      let fd: number | undefined;
      try {
        fd = openSync(parsed.value, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_SECRET_BYTES || (stat.mode & 0o077) !== 0) {
          throw new Error("invalid secret file");
        }
        const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const count = readSync(fd, bytes, size, bytes.length - size, null);
          if (count === 0) break;
          size += count;
        }
        if (size > MAX_SECRET_BYTES) throw new Error("invalid secret file");
        value = bytes.subarray(0, size).toString("utf8").trim();
      } catch {
        throw new Error("Token file must be a readable, owner-only regular file of at most 16 KiB.");
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (value === undefined || value.length === 0 || value.length > MAX_SECRET_BYTES || /\s|[\x00-\x1f\x7f]/.test(value)) {
      throw new Error("Connection token is missing or invalid. Set the enrolled secret reference and retry.");
    }
    return value;
  });
}
