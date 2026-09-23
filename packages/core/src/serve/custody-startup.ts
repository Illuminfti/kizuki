import { closeSync, fsyncSync, lstatSync, readdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { custodyNative } from "../util/custody-native";
import { SERVICE_READY_SECONDS } from "./units";

/** The launcher allows the broker the whole READY window, and a start under a
 * CPU quota can use all of it; the main process waits at least that long. */
export const CUSTODY_CONNECT_TIMEOUT_MS = SERVICE_READY_SECONDS * 1_000;

export function custodyEndpointStat(control: number, name: string): BigIntStats {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name) || name === "." || name === "..") throw new Error("service_custody_unavailable");
  const stat = lstatSync(`/proc/self/fd/${control}/${name}`, { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(process.geteuid!()) ||
      (stat.mode & 0o7777n) !== 0o600n || stat.nlink !== 1n) throw new Error("service_custody_unavailable");
  return stat;
}

/** The socket pathname becomes visible before listen(2). Pin it at first
 * observation; a replacement or authority loss is never a readiness retry. */
export async function connectServiceCustody(
  control: number, name: string, assertAuthority: () => void, timeoutMs = CUSTODY_CONNECT_TIMEOUT_MS,
): Promise<{ socket: number; endpoint: BigIntStats }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > CUSTODY_CONNECT_TIMEOUT_MS) throw new Error("service_custody_unavailable");
  const deadline = performance.now() + timeoutMs;
  let endpoint: BigIntStats | undefined;
  const observe = (): BigIntStats => {
    const current = custodyEndpointStat(control, name);
    if (endpoint !== undefined && (current.dev !== endpoint.dev || current.ino !== endpoint.ino ||
        current.mode !== endpoint.mode || current.uid !== endpoint.uid || current.gid !== endpoint.gid ||
        current.ctimeNs !== endpoint.ctimeNs || current.nlink !== endpoint.nlink)) throw new Error("service_custody_unavailable");
    return current;
  };
  while (performance.now() < deadline) {
    assertAuthority();
    try {
      endpoint = observe();
    } catch (error) {
      if (endpoint !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    let socket: number;
    try { socket = custodyNative().connect(control, name); }
    catch {
      assertAuthority();
      observe();
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    try { assertAuthority(); observe(); return { socket, endpoint }; }
    catch (error) { closeSync(socket); throw error; }
  }
  throw new Error("service_custody_unavailable");
}

const ENDPOINT = /^custody-[0-9a-f]{32}\.sock$/;
type EndpointProbe = (control: number, name: string) => "refused" | "listening" | "unknown";
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"; }
/** A killed invocation never runs its broker's cleanup, and every invocation
 * names a new endpoint. One unit serves one vault, so before listening the
 * broker unlinks each other owner-only socket nothing listens on any more.
 * Live, unexpected or non-socket entries are left alone and reported. An entry
 * that disappears meanwhile is already gone; no entry can make the sweep throw. */
export function sweepStaleCustodyEndpoints(
  control: number, own: string, probe: EndpointProbe = (fd, name) => custodyNative().probe(fd, name),
): { removed: string[]; kept: string[]; gone: string[] } {
  const removed: string[] = [], kept: string[] = [], gone: string[] = [];
  let names: string[];
  try { names = readdirSync(`/proc/self/fd/${control}`).sort(); } catch { return { removed, kept, gone }; }
  for (const name of names) {
    if (!ENDPOINT.test(name) || name === own) continue;
    try {
      const before = custodyEndpointStat(control, name);
      if (probe(control, name) !== "refused") { kept.push(name); continue; }
      const after = custodyEndpointStat(control, name);
      if (after.dev !== before.dev || after.ino !== before.ino || after.ctimeNs !== before.ctimeNs) { kept.push(name); continue; }
      unlinkSync(`/proc/self/fd/${control}/${name}`);
      removed.push(name);
    } catch (error) { (absent(error) ? gone : kept).push(name); }
  }
  try { if (removed.length > 0) fsyncSync(control); } catch { /* The unlinks stand; durability of a cleanup is best effort. */ }
  return { removed, kept, gone };
}
