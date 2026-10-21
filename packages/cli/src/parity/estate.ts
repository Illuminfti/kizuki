import { boundedCommand, type ProcessFailure } from "./process";

export type EstateErrorClass = ProcessFailure;

export interface EstateAnswer {
  latencyMs: number;
  /** Source keys the stack returned, deduplicated, in its own order, at most k. */
  keys: string[];
  error?: { class: EstateErrorClass; exitCode: number | null };
}

const MAX_KEY_CHARS = 1024;
export const QUERY_PLACEHOLDER = "{query}";

/** `{query}` in any argument is replaced; without one the query is appended as the last argument. */
export function estateArgv(argv: readonly string[], query: string): string[] {
  return argv.some((arg) => arg.includes(QUERY_PLACEHOLDER))
    ? argv.map((arg) => arg.replaceAll(QUERY_PLACEHOLDER, () => query))
    : [...argv, query];
}

function parseKeys(output: string, k: number): string[] {
  const keys = new Set<string>();
  for (const line of output.split("\n")) {
    const key = line.trim();
    if (key.length === 0 || key.length > MAX_KEY_CHARS) continue;
    keys.add(key);
    if (keys.size === k) break;
  }
  return [...keys];
}

/**
 * Runs one local command for one query: no shell, no stdin, stderr discarded, stdout read up to a
 * fixed bound, the whole run cut off at `timeoutMs`,
 * killing the command's whole process group on timeout or overflow. The command's own words never reach a receipt.
 */
export async function askEstate(
  argv: readonly string[],
  query: string,
  options: { timeoutMs: number; k: number; signal?: AbortSignal },
): Promise<EstateAnswer> {
  const result = await boundedCommand(estateArgv(argv, query), options);
  return result.error === undefined
    ? { latencyMs: result.latencyMs, keys: parseKeys(result.stdout, options.k) }
    : { latencyMs: result.latencyMs, keys: [], error: { class: result.error, exitCode: result.error === "nonzero_exit" ? result.exitCode : null } };
}
