export type EstateErrorClass = "spawn_failed" | "timeout" | "nonzero_exit" | "output_too_large";

export interface EstateAnswer {
  latencyMs: number;
  /** Source keys the stack returned, deduplicated, in its own order, at most k. */
  keys: string[];
  error?: { class: EstateErrorClass; exitCode: number | null };
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
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
  options: { timeoutMs: number; k: number },
): Promise<EstateAnswer> {
  const started = performance.now();
  const latency = (): number => Math.round(performance.now() - started);
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn(estateArgv(argv, query), { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  } catch {
    return { latencyMs: latency(), keys: [], error: { class: "spawn_failed", exitCode: null } };
  }

  const reader = child.stdout.getReader();
  let timedOut = false;
  let overLimit = false;
  const stop = (): void => {
    // The child leads its own process group, so a wrapper's grandchildren die with it.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);

  const chunks: Uint8Array[] = [];
  try {
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        overLimit = true;
        stop();
        break;
      }
      chunks.push(value);
    }
    await child.exited;
  } catch {
    // A cancelled read ends the loop; the flags below say why.
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = latency();
  if (timedOut) return { latencyMs, keys: [], error: { class: "timeout", exitCode: null } };
  if (overLimit) return { latencyMs, keys: [], error: { class: "output_too_large", exitCode: null } };
  const exitCode = child.exitCode;
  if (exitCode !== 0) return { latencyMs, keys: [], error: { class: "nonzero_exit", exitCode } };
  return { latencyMs, keys: parseKeys(Buffer.concat(chunks).toString("utf8"), options.k) };
}
