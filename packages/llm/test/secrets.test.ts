import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmError } from "../src/errors";
import { resolveApiKey } from "../src/secrets";

const CANARY = "sk-canary-2b9e4d";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function keyFile(content: string, mode: number): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-llm-key-"));
  directories.push(directory);
  const path = join(directory, "key");
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function failure(run: () => unknown): LlmError {
  try {
    run();
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw error;
  }
  throw new Error("expected resolveApiKey to throw");
}

describe("resolveApiKey", () => {
  test("resolves an env: reference from the given environment", () => {
    expect(resolveApiKey("env:KIZUKI_TEST_KEY", { KIZUKI_TEST_KEY: CANARY })).toBe(
      CANARY,
    );
  });

  test("an unset variable is missing_key and the message names the reference", () => {
    const error = failure(() => resolveApiKey("env:KIZUKI_TEST_KEY", {}));
    expect(error.code).toBe("missing_key");
    expect(error.message).toContain("env:KIZUKI_TEST_KEY");
  });

  test("an empty variable is missing_key", () => {
    expect(
      failure(() => resolveApiKey("env:KIZUKI_TEST_KEY", { KIZUKI_TEST_KEY: "" })).code,
    ).toBe("missing_key");
  });

  test("resolves a 0600 file: reference and trims one trailing newline", () => {
    expect(resolveApiKey(`file:${keyFile(`${CANARY}\n`, 0o600)}`)).toBe(CANARY);
    expect(resolveApiKey(`file:${keyFile(`${CANARY}\n\n`, 0o600)}`)).toBe(
      `${CANARY}\n`,
    );
    expect(resolveApiKey(`file:${keyFile(CANARY, 0o400)}`)).toBe(CANARY);
  });

  test("a key file readable by others is refused", () => {
    const error = failure(() => resolveApiKey(`file:${keyFile(CANARY, 0o644)}`));
    expect(error.code).toBe("key_file_permissions");
    expect(failure(() => resolveApiKey(`file:${keyFile(CANARY, 0o660)}`)).code).toBe(
      "key_file_permissions",
    );
  });

  test("a missing or empty key file is missing_key", () => {
    const path = keyFile(CANARY, 0o600);
    rmSync(path);
    expect(failure(() => resolveApiKey(`file:${path}`)).code).toBe("missing_key");
    expect(failure(() => resolveApiKey(`file:${keyFile("\n", 0o600)}`)).code).toBe(
      "missing_key",
    );
  });

  test("a relative file: reference and a non-reference are bad_secret_ref", () => {
    expect(failure(() => resolveApiKey("file:relative/key")).code).toBe(
      "bad_secret_ref",
    );
    expect(failure(() => resolveApiKey(CANARY)).code).toBe("bad_secret_ref");
  });

  test("no failure message carries the key value", () => {
    const messages = [
      failure(() => resolveApiKey(CANARY)).message,
      failure(() => resolveApiKey(`file:${keyFile(CANARY, 0o644)}`)).message,
      failure(() => resolveApiKey("env:KIZUKI_TEST_KEY", { KIZUKI_TEST_KEY: "" }))
        .message,
    ];
    for (const message of messages) expect(message).not.toContain(CANARY);
  });
});
