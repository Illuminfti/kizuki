import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServeProcessMarker } from "./daemon";
import { SERVE_ENDPOINT_PATH } from "./types";

const SCHEMA = "kizuki.serve-endpoint/v1";
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

export interface ServeEndpoint {
  readonly host: string;
  readonly port: number;
  /** Origin a client may call, for example `http://127.0.0.1:41234`. */
  readonly url: string;
}

/** The running daemon announces where its loopback endpoint listens. Never holds a credential. */
export function writeServeEndpoint(
  vaultPath: string,
  endpoint: { host: string; port: number; instance_id: string },
): void {
  const path = join(vaultPath, SERVE_ENDPOINT_PATH);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(staged, `${JSON.stringify({ schema: SCHEMA, ...endpoint })}\n`, { mode: 0o600 });
  chmodSync(staged, 0o600);
  renameSync(staged, path);
}

export function clearServeEndpoint(vaultPath: string): void {
  try { unlinkSync(join(vaultPath, SERVE_ENDPOINT_PATH)); } catch { /* Already gone. */ }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * The endpoint of the daemon that is running now, or null. A file left by a
 * dead or replaced daemon is ignored: it must name the instance in `marker`
 * (the vault's current process marker), and that process must exist.
 */
export function readServeEndpoint(vaultPath: string, marker: ServeProcessMarker | null): ServeEndpoint | null {
  try {
    const path = join(vaultPath, SERVE_ENDPOINT_PATH);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    if (raw.length > 1024) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).sort().join() !== "host,instance_id,port,schema" || fields["schema"] !== SCHEMA) return null;
    const { host, port, instance_id: instance } = fields;
    if (typeof host !== "string" || !LOOPBACK.has(host) || typeof port !== "number" ||
        !Number.isInteger(port) || port < 1 || port > 65_535 || typeof instance !== "string") return null;
    if (marker === null || marker.instance_id !== instance || !alive(marker.pid)) return null;
    return { host, port, url: `http://${host === "::1" ? "[::1]" : host}:${port}` };
  } catch {
    return null;
  }
}
