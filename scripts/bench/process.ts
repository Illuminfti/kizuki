import { join } from "node:path";

export const ROOT = join(import.meta.dir, "../..");
export const CLI = join(ROOT, "packages/cli/src/main.ts");
export const MCP = join(ROOT, "packages/mcp/src/bin.ts");
export const WORKER = join(import.meta.dir, "worker.ts");
const children = new Set<Bun.Subprocess>();
let cancelled = false;

// Bun 1.3.14 exposes native ru_maxrss despite its subprocess type saying bytes.
export function nativePeakRssBytes(value: number): number {
  return value * (process.platform === "darwin" ? 1 : 1024);
}

export async function cancelChildren(): Promise<void> {
  cancelled = true;
  await stopChildren();
}

/** Use a small explicit environment: no model credentials or owner configuration can enter children. */
export function childEnvironment(): Record<string, string> {
  const temporary = process.env.TMPDIR ?? "/tmp";
  return { PATH: process.env.PATH ?? "", TMPDIR: temporary, XDG_CONFIG_HOME: join(temporary, "kizuki-benchmark-empty-config"), LANG: "C", TZ: "UTC", KIZUKI_NO_SERVICE: "1" };
}
export async function command(argv: string[], input?: string, acceptedCodes = [0]) {
  if (cancelled) throw new Error("benchmark cancelled");
  const started = performance.now();
  const child = Bun.spawn([process.execPath, ...argv], { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", env: childEnvironment(), cwd: ROOT });
  children.add(child);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 24 * 60 * 60 * 1000);
  try {
    if (input !== undefined && typeof child.stdin !== "number" && child.stdin !== undefined && child.stdin !== null) { child.stdin.write(input); child.stdin.end(); }
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const wallMs = performance.now() - started;
    if (!acceptedCodes.includes(code)) throw new Error(`benchmark child failed (${code}): ${stderr.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400)}`);
    const usage = child.resourceUsage();
    if (usage === undefined || usage.maxRSS <= 0) throw new Error("child resource usage unavailable");
    return { stdout, wall_ms: wallMs, rss_bytes: nativePeakRssBytes(usage.maxRSS) };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    children.delete(child);
  }
}
export async function stopChildren(): Promise<void> {
  const live = [...children];
  for (const child of live) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(live.map(child => child.exited));
}
