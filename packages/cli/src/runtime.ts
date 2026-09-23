import { fileURLToPath } from "node:url";

declare const KIZUKI_COMPILED: boolean;

/**
 * Set only by the release compiler.  A runtime environment variable would let
 * an untrusted service environment change the command it installs.
 */
export const IS_COMPILED =
  typeof KIZUKI_COMPILED !== "undefined" && KIZUKI_COMPILED;

/** The copy-pasteable invocation shown in CLI help. */
export const INVOCATION = IS_COMPILED ? "kizuki" : "bun packages/cli/src/main.ts";

/** Arguments for a supervisor. Rendering is the supervisor's responsibility. */
export function serveArgs(vaultPath: string): string[] {
  if (IS_COMPILED) return [process.execPath, "serve", "--vault", vaultPath];
  const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
  return [process.execPath, entry, "serve", "--vault", vaultPath];
}

/** One POSIX shell word: a plain path prints as it is, anything else is single-quoted. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
