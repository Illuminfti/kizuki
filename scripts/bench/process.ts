import { join } from "node:path";

export const ROOT = join(import.meta.dir, "../..");
export const CLI = join(ROOT, "packages/cli/src/main.ts");
export const MCP = join(ROOT, "packages/mcp/src/bin.ts");
export const WORKER = join(import.meta.dir, "worker.ts");
const LAUNCHER = join(import.meta.dir, "launcher.ts");
const children = new Map<Bun.Subprocess, boolean>();
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
  // A small launcher prevents the harness's growing RSS from becoming the
  // child's inherited pre-exec high-water mark. Its own startup is not timed.
  const measured = await executeChild([LAUNCHER, JSON.stringify({ argv, acceptedCodes, hasInput: input !== undefined })], input, [0], true);
  return JSON.parse(measured.stdout) as { stdout: string; wall_ms: number; rss_bytes: number };
}

export async function executeChild(argv: string[], input?: string, acceptedCodes = [0], isolatedGroup = false) {
  if (cancelled) throw new Error("benchmark cancelled");
  const started = performance.now();
  const child = Bun.spawn([process.execPath, ...argv], { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", env: childEnvironment(), cwd: ROOT, detached: isolatedGroup });
  children.set(child, isolatedGroup);
  const deadline = setTimeout(() => killChild(child, isolatedGroup), 24 * 60 * 60 * 1000);
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
    if (child.exitCode === null) { killChild(child, isolatedGroup); await child.exited; }
    children.delete(child);
  }
}
function killChild(child: Bun.Subprocess, group: boolean) {
  if (!group) { child.kill("SIGKILL"); return; }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
export async function stopChildren(): Promise<void> {
  const live = [...children];
  for (const [child, group] of live) if (child.exitCode === null) killChild(child, group);
  await Promise.all(live.map(([child]) => child.exited));
}
