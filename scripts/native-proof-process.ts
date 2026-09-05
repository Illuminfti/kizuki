/** Fixed native-proof limits; callers retain observations before testing exit codes. */
import { hash } from "./native-proof-evidence";

export const NATIVE_LIMITS = { timeout_ms: 30000, stdout_bytes: 1048576, stderr_bytes: 65536, frame_bytes: 262144 } as const;
export type ProcessFault = "deadline" | "stdout-overflow" | "stderr-overflow" | "stream-error" | "protocol-error" | "early-eof";
export interface ProcessObservation {
  exit_code: number; wall_ms: number; fault: ProcessFault | null;
  stdout_bytes: number; stderr_bytes: number; stdout_sha256: string; stderr_sha256: string;
}
interface SpawnOptions { cwd: string; env: Record<string, string>; timeout_ms?: number }
export interface NativeResult { stdout: string; stderr: string; observation: ProcessObservation }

async function collect(stream: ReadableStream<Uint8Array>, limit: number, overflow: () => void) {
  const parts: Uint8Array[] = []; let bytes = 0, exceeded = false;
  for await (const part of stream) {
    bytes += part.byteLength;
    if (bytes > limit) { if (!exceeded) overflow(); exceeded = true; }
    else if (!exceeded) parts.push(part);
  }
  const retained = Buffer.concat(parts);
  return { retained, bytes };
}

export async function runNativeCommand(argv: readonly string[], options: SpawnOptions): Promise<NativeResult> {
  const start = performance.now(); let fault: ProcessFault | null = null;
  const child = Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stop = (reason: ProcessFault) => { fault ??= reason; if (child.exitCode === null) child.kill("SIGKILL"); };
  const timer = setTimeout(() => stop("deadline"), options.timeout_ms ?? NATIVE_LIMITS.timeout_ms);
  const stdout = collect(child.stdout, NATIVE_LIMITS.stdout_bytes, () => stop("stdout-overflow"));
  const stderr = collect(child.stderr, NATIVE_LIMITS.stderr_bytes, () => stop("stderr-overflow"));
  try {
    const results = await Promise.allSettled([stdout, stderr, child.exited]);
    if (results.some(result => result.status === "rejected")) { stop("stream-error"); await child.exited; }
    const out = results[0]!.status === "fulfilled" ? results[0]!.value : { retained: Buffer.alloc(0), bytes: 0 };
    const err = results[1]!.status === "fulfilled" ? results[1]!.value : { retained: Buffer.alloc(0), bytes: 0 };
    return { stdout: out.retained.toString("utf8"), stderr: err.retained.toString("utf8"), observation: {
      exit_code: await child.exited, wall_ms: Math.round(performance.now() - start), fault,
      stdout_bytes: out.bytes, stderr_bytes: err.bytes, stdout_sha256: hash(out.retained), stderr_sha256: hash(err.retained),
    } };
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}

export interface McpRequestObservation { request_id: number; method: "initialize" | "tools/call"; response_sha256: string; }
export interface NativeMcpSession {
  requests: McpRequestObservation[];
  call(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<ProcessObservation>;
}

export async function openNativeMcp(argv: readonly string[], options: SpawnOptions): Promise<NativeMcpSession> {
  const start = performance.now(), requests: McpRequestObservation[] = [];
  const child = Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let fault: ProcessFault | null = null, closing = false, nextId = 0, stdoutBytes = 0;
  const chunks: Uint8Array[] = [];
  let pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  const currentPending = () => pending;
  const stop = (reason: ProcessFault) => {
    fault ??= reason; pending?.reject(new Error(`native-mcp-${fault}`)); pending = null;
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  const stderr = collect(child.stderr, NATIVE_LIMITS.stderr_bytes, () => stop("stderr-overflow")).catch(() => { stop("stream-error"); return { retained: Buffer.alloc(0), bytes: 0 }; });
  const stdout = (async () => {
    let buffered = Buffer.alloc(0);
    try {
      for await (const part of child.stdout) {
        stdoutBytes += part.byteLength;
        if (stdoutBytes > NATIVE_LIMITS.stdout_bytes) { stop("stdout-overflow"); continue; }
        chunks.push(part); buffered = Buffer.concat([buffered, part]);
        let end: number;
        while ((end = buffered.indexOf(10)) >= 0) {
          if (end > NATIVE_LIMITS.frame_bytes) { stop("protocol-error"); return; }
          const line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
          if (line.length === 0) continue;
          const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as Record<string, unknown>;
          const waiter = currentPending();
          if (!message || message.jsonrpc !== "2.0" || !waiter || message.id !== waiter.id || message.error !== undefined || !("result" in message)) { stop("protocol-error"); return; }
          pending = null; waiter.resolve(message.result);
        }
        if (buffered.length > NATIVE_LIMITS.frame_bytes) { stop("protocol-error"); return; }
      }
      if (buffered.length || !closing || pending) stop("early-eof");
    } catch { stop("protocol-error"); }
  })();
  const exited = child.exited.then(() => { if (!closing || pending) stop("early-eof"); });
  function send(value: unknown) { child.stdin.write(JSON.stringify(value) + "\n"); child.stdin.flush(); }
  async function rpc(method: "initialize" | "tools/call", params: unknown) {
    if (fault || closing || pending) throw new Error("native-mcp-unavailable");
    const id = ++nextId;
    const answer = new Promise<unknown>((resolve, reject) => { pending = { id, resolve, reject }; });
    const timer = setTimeout(() => stop("deadline"), options.timeout_ms ?? NATIVE_LIMITS.timeout_ms);
    try {
      send({ jsonrpc: "2.0", id, method, params }); const result = await answer;
      if (fault) throw new Error("native-mcp-unavailable");
      requests.push({ request_id: id, method, response_sha256: hash(JSON.stringify(result)) }); return result;
    } finally { clearTimeout(timer); }
  }
  let closeResult: Promise<ProcessObservation> | null = null;
  function close(): Promise<ProcessObservation> {
    closeResult ??= (async () => {
      closing = true; child.stdin.end();
      const timer = setTimeout(() => stop("deadline"), options.timeout_ms ?? NATIVE_LIMITS.timeout_ms);
      try {
        await Promise.all([stdout, exited]); const err = await stderr;
        return { exit_code: await child.exited, wall_ms: Math.round(performance.now() - start), fault,
          stdout_bytes: stdoutBytes, stderr_bytes: err.bytes, stdout_sha256: hash(Buffer.concat(chunks)), stderr_sha256: hash(err.retained) };
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    })();
    return closeResult;
  }
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kizuki-native-proof", version: "2" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return { requests, call: (name, arguments_) => rpc("tools/call", { name, arguments: arguments_ }), close };
  } catch (error) { await close(); throw error; }
}
