import { parseSqliteRuntime } from "../packages/core/src/ledger/runtime";
import { parseProofJson } from "./artifact-proof";
import type { CliEngineObservation, McpEngineObservation } from "./artifact-proof";

const STREAM_LIMIT = 16 * 1024;
const CHILD_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2025-06-18";

export class EngineProofError extends Error {
  constructor(code: "engine-response-invalid" | "engine-output-limit" | "engine-timeout" | "engine-process-failed") {
    super(code);
  }
}

function invalid(): never { throw new EngineProofError("engine-response-invalid"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function strings(value: unknown): boolean { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

/** Project the runtime only; an unhealthy doctor is still unhealthy. */
export function parseDoctorObservation(stdout: string, exitCode: number, executableSha256: string): CliEngineObservation {
  try {
    const row = object(parseProofJson(stdout));
    keys(row, ["schema", "status", "data", "degraded", "warnings"]);
    const data = object(row.data);
    if (row.schema !== "kizuki.cli.doctor/v1" || !strings(row.degraded) || !strings(row.warnings) ||
        !((exitCode === 0 && row.status === "ok" && data.ok === true) ||
          (exitCode === 1 && row.status === "error" && data.ok === false))) invalid();
    return { executable_sha256: executableSha256, runtime: parseSqliteRuntime(data.runtime),
      exit_code: exitCode as 0 | 1, doctor_status: row.status as "ok" | "error" };
  } catch { return invalid(); }
}

export function parseMcpObservation(value: unknown, executableSha256: string): McpEngineObservation {
  try {
    const result = object(value);
    keys(result, ["content"], ["structuredContent", "isError"]);
    if (result.isError !== undefined && result.isError !== false) invalid();
    if (!Array.isArray(result.content) || result.content.length !== 1) invalid();
    const text = object(result.content[0]);
    keys(text, ["type", "text"]);
    if (text.type !== "text" || typeof text.text !== "string") invalid();
    const envelope = object(parseProofJson(text.text));
    keys(envelope, ["schema", "tool", "principal", "at", "canon", "quoted", "denied", "data"], ["source_policy"]);
    if (envelope.schema !== "kizuki.envelope/v1" || envelope.tool !== "system_health" || envelope.principal !== "owner" ||
        typeof envelope.at !== "string" || !Number.isFinite(Date.parse(envelope.at)) ||
        ![envelope.canon, envelope.quoted, envelope.denied].every(item => Array.isArray(item) && item.length === 0) ||
        (result.structuredContent !== undefined && canonical(result.structuredContent) !== canonical(envelope))) invalid();
    return { executable_sha256: executableSha256, runtime: parseSqliteRuntime(object(envelope.data).runtime), exit_code: 0, mcp_is_error: false };
  } catch { return invalid(); }
}

function response(line: string, id: number): Record<string, unknown> {
  const row = object(parseProofJson(line));
  keys(row, ["jsonrpc", "id", "result"]);
  if (row.jsonrpc !== "2.0" || row.id !== id) invalid();
  return object(row.result);
}

/** Two bounded pipes and one deadline cover startup, protocol and final exit.
 * stderr is counted then discarded, never retained in the proof. */
export async function collectEngineProcess(
  executable: string, args: readonly string[], cwd: string, env: Record<string, string>, mcp: boolean,
): Promise<{ stdout: string; exit_code: number }> {
  let child;
  try { child = Bun.spawn([executable, ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }); }
  catch { throw new EngineProofError("engine-process-failed"); }
  let failure: EngineProofError | undefined;
  const fail = (error: EngineProofError): void => {
    failure ??= error;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => fail(new EngineProofError("engine-timeout")), CHILD_TIMEOUT_MS);
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  let phase = 0, pending = "";
  const onLine = (line: string) => {
    if (phase === 0) {
      const init = response(line, 1);
      if (init.protocolVersion !== PROTOCOL_VERSION || !init.capabilities || !init.serverInfo) invalid();
      object(init.capabilities); object(init.serverInfo);
      phase = 1;
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "system_health", arguments: {} } });
    } else if (phase === 1) {
      // Validate the entire response before accepting it or closing the session.
      parseMcpObservation(response(line, 2), "0".repeat(64));
      phase = 2;
      child.stdin.end();
    } else invalid();
  };
  const consume = async (stream: ReadableStream<Uint8Array>, stdout: boolean): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0, output = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > STREAM_LIMIT) throw new EngineProofError("engine-output-limit");
        if (stdout) {
          const text = decoder.decode(value, { stream: true });
          output += text;
          if (mcp) {
            pending += text;
            while (pending.includes("\n")) {
              const end = pending.indexOf("\n"), line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              onLine(line);
            }
          }
        }
      }
      if (stdout) output += decoder.decode();
      return output;
    } catch (error) {
      fail(error instanceof EngineProofError ? error : new EngineProofError("engine-response-invalid"));
      // Reaping below completes before the caller receives this failure.
      return "";
    } finally { reader.releaseLock(); }
  };
  const stdout = consume(child.stdout, true), stderr = consume(child.stderr, false);
  try {
    if (mcp) send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "kizuki-artifact-proof", version: "2" },
    } });
    else child.stdin.end();
    const [output, , code] = await Promise.all([stdout, stderr, child.exited]);
    if (failure) throw failure;
    if (mcp && (phase !== 2 || pending !== "" || code !== 0)) invalid();
    return { stdout: output, exit_code: code };
  } catch (error) {
    fail(error instanceof EngineProofError ? error : new EngineProofError("engine-process-failed"));
    await Promise.allSettled([stdout, stderr, child.exited]);
    throw failure;
  } finally { clearTimeout(timer); }
}

export function mcpObservationFromOutput(stdout: string, executableSha256: string): McpEngineObservation {
  try {
    const lines = stdout.split("\n");
    if (lines.length !== 3 || lines[2] !== "") invalid();
    response(lines[0]!, 1);
    return parseMcpObservation(response(lines[1]!, 2), executableSha256);
  } catch { return invalid(); }
}
