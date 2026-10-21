export type ProcessFailure = "spawn_failed" | "timeout" | "nonzero_exit" | "output_too_large" | "io_error" | "cancelled";
export interface ProcessAnswer {
  latencyMs: number;
  stdout: string;
  exitCode: number | null;
  error?: ProcessFailure;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Own the entire command group and drain its bounded output before returning.
 * A deadline cancels actual work; no abandoned read continues behind a race. */
export async function boundedCommand(argv: readonly string[], options: {
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}): Promise<ProcessAnswer> {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  if (options.signal?.aborted) return { latencyMs: latency(), stdout: "", exitCode: null, error: "cancelled" };
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true,
      ...(options.env === undefined ? {} : { env: options.env }) });
  } catch {
    return { latencyMs: latency(), stdout: "", exitCode: null, error: "spawn_failed" };
  }
  const reader = child.stdout.getReader();
  let failure: ProcessFailure | undefined;
  const kill = () => {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
    }
  };
  const stop = (reason: ProcessFailure) => {
    failure ??= reason;
    kill();
    void reader.cancel().catch(() => undefined);
  };
  const abort = () => stop("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const deadline = setTimeout(() => stop("timeout"), options.timeoutMs);
  const chunks: Uint8Array[] = [];
  try {
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_OUTPUT_BYTES) { stop("output_too_large"); break; }
        chunks.push(value);
      }
    } catch { stop("io_error"); }
    await child.exited;
    if (failure === undefined && child.exitCode !== 0) failure = "nonzero_exit";
    return { latencyMs: latency(), stdout: failure === undefined || failure === "nonzero_exit" ? Buffer.concat(chunks).toString("utf8") : "",
      exitCode: child.exitCode, ...(failure === undefined ? {} : { error: failure }) };
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
    // Even a successful wrapper must not leave descendants doing shadow work.
    kill();
    await child.exited;
    reader.releaseLock();
  }
}
