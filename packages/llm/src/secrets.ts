import { readFileSync, statSync } from "node:fs";
import { parseSecretRef } from "@kizuki/core";
import { LlmError } from "./errors";

/**
 * Resolves an `env:VAR` or `file:/abs/path` reference at use time. Failures
 * name the reference, never a value; a key file readable by anyone but its
 * owner is refused outright.
 */
export function resolveApiKey(
  ref: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const parsed = parseSecretRef(ref);
  if (parsed === null) {
    throw new LlmError(
      "bad_secret_ref",
      "api_key must be a secret reference (env:VAR or file:/abs/path)",
    );
  }
  if (parsed.scheme === "env") {
    const value = env[parsed.value];
    if (value === undefined || value.length === 0) {
      throw new LlmError(
        "missing_key",
        `api_key ${ref} is not set; export ${parsed.value} or point api_key at another reference`,
      );
    }
    return value;
  }

  const path = parsed.value;
  if (!path.startsWith("/")) {
    throw new LlmError(
      "bad_secret_ref",
      "api_key file: reference must be an absolute path",
    );
  }
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new LlmError("missing_key", `api_key ${ref} cannot be read`);
  }
  if ((mode & 0o077) !== 0) {
    throw new LlmError(
      "key_file_permissions",
      `api_key ${ref} is readable by other users; chmod 600 it`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new LlmError("missing_key", `api_key ${ref} cannot be read`);
  }
  const key = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  if (key.length === 0) {
    throw new LlmError("missing_key", `api_key ${ref} is empty`);
  }
  return key;
}
