import { test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Creates temporary directories owned by the run that asked for them. Paths are
 * resolved through `realpath`, so vault custody sees the same ancestor the
 * platform reports rather than an alias such as macOS's `/tmp`.
 */
export interface RootFactory {
  (prefix?: string): Promise<string>;
  sync(prefix?: string): string;
}

/**
 * Runs `body` with a factory whose directories are removed once the body
 * settles. Ownership never leaves the body, so a hook running for a different
 * test, including one the runner already reported as timed out, can never
 * remove a directory the body is still reading or writing.
 */
export async function withOwnedRoots<T>(
  defaultPrefix: string,
  body: (makeRoot: RootFactory) => Promise<T>,
): Promise<T> {
  const owned: string[] = [];
  const makeRoot = (async (prefix = defaultPrefix) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), prefix)),
    );
    owned.push(root);
    return root;
  }) as RootFactory;
  makeRoot.sync = (prefix = defaultPrefix) => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
    owned.push(root);
    return root;
  };
  try {
    return await body(makeRoot);
  } finally {
    await Promise.all(
      owned.map((root) => rm(root, { recursive: true, force: true })),
    );
  }
}

/**
 * Deadline for a body that drives a full ingest round trip. That work runs for
 * tens of seconds on a loaded machine, and reporting it as a timeout would let
 * the body outlive the test the runner has already closed.
 */
export const ROUND_TRIP_TIMEOUT_MS = 120_000;

/**
 * Builds a `test` that owns its temporary directories. Directories default to
 * `defaultPrefix` and are removed when the body settles, whatever verdict the
 * runner has already recorded.
 */
export function rootTest(defaultPrefix: string) {
  return (
    name: string,
    body: (makeRoot: RootFactory) => Promise<void>,
    timeout: number = ROUND_TRIP_TIMEOUT_MS,
  ): void => {
    test(name, () => withOwnedRoots(defaultPrefix, body), timeout);
  };
}
