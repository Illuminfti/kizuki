import { readFileSync } from "node:fs";

export interface Budget { timeoutMs: number; rssMiB: number }
export interface WorkerReceipt { code: number; limit: "time" | "memory" | "output" | null; lastCase: string; completed: number; peakRssKiB: number; property: string | null }

/** Owns and reaps exactly one child. Reads output incrementally with a line bound. */
export async function supervise(command: string[], budget: Budget): Promise<WorkerReceipt> {
  if (process.platform !== "linux") throw new Error("fuzz supervision requires Linux RSS accounting");
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let limit: WorkerReceipt["limit"] = null, lastCase = "startup", completed = 0, peakRssKiB = 0;
  let property: string | null = null;
  let complete = false;
  const stop = (reason: NonNullable<WorkerReceipt["limit"]>) => {
    if (limit === null) {
      limit = reason;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  };
  const deadline = setTimeout(() => stop("time"), budget.timeoutMs);
  const sample = setInterval(() => {
    try {
      const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
      const peak = Number(/^VmHWM:\s+(\d+)\s+kB$/m.exec(status)?.[1] ?? 0);
      peakRssKiB = Math.max(peakRssKiB, peak);
      if (peakRssKiB > budget.rssMiB * 1024) stop("memory");
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT" && (error as { code?: unknown }).code !== "ESRCH") {
        property = "rss-accounting-failed";
        stop("memory");
      }
    }
  }, 25);
  const consume = (async () => {
    const reader = child.stdout.getReader();
    let pending = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += new TextDecoder().decode(chunk.value);
        let end;
        while ((end = pending.indexOf("\n")) !== -1) {
          if (end > 4096) { stop("output"); return; }
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            if (typeof value["case"] === "string") lastCase = value["case"];
            if (typeof value["completed"] === "number") completed = value["completed"];
            if (typeof value["maxRssKiB"] === "number") peakRssKiB = Math.max(peakRssKiB, value["maxRssKiB"]);
            if (typeof value["property"] === "string") property = value["property"];
            if (Number.isSafeInteger(value["completed"]) && (value["completed"] as number) >= 0 &&
                typeof value["maxRssKiB"] === "number" && Number.isFinite(value["maxRssKiB"]) && value["maxRssKiB"] > 0) complete = true;
          } catch { stop("output"); return; }
        }
        if (pending.length > 4096) { stop("output"); return; }
      }
      if (pending !== "") stop("output");
    } finally { reader.releaseLock(); }
  })();
  try {
    const code = await child.exited;
    await consume;
    if (peakRssKiB > budget.rssMiB * 1024) limit = "memory";
    if (code === 0 && limit === null && property === null && !complete) property = "worker-incomplete";
    return { code, limit, lastCase, completed, peakRssKiB, property };
  } finally {
    clearTimeout(deadline); clearInterval(sample);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
