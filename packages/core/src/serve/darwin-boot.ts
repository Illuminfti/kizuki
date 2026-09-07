import { dlopen, ptr } from "bun:ffi";

let cached: string | undefined;

/** A native boot-session identity, never a process-local or invented UUID. */
export function readDarwinBootSessionId(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return null;
  if (cached !== undefined) return cached;
  try {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctlbyname: { args: ["ptr", "ptr", "ptr", "ptr", "usize"], returns: "i32" },
    });
    let candidate: string | null = null;
    try {
      const name = Buffer.from("kern.bootsessionuuid\0");
      const output = Buffer.alloc(37, 0xff);
      // Darwin ARM64 size_t is 64-bit; preserve its alignment, not just size.
      const length = new BigUint64Array([37n]);
      const result = library.symbols.sysctlbyname(ptr(name), ptr(output), ptr(length), null, 0);
      if (result === 0 && length[0] === 37n && output[36] === 0) {
        const value = output.subarray(0, 36).toString("latin1");
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
            value !== "00000000-0000-0000-0000-000000000000") candidate = value.toLowerCase();
      }
    } finally { library.close(); }
    // Failed native reads (including cleanup) never become a boot identity.
    if (candidate !== null) cached = candidate;
    return candidate;
  } catch { return null; }
}
