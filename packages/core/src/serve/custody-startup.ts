import { closeSync, lstatSync, type BigIntStats } from "node:fs";
import { custodyNative } from "../util/custody-native";

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
  control: number, name: string, assertAuthority: () => void, timeoutMs = 10_000,
): Promise<{ socket: number; endpoint: BigIntStats }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw new Error("service_custody_unavailable");
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
