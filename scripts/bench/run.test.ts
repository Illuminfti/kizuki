import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRICS, parseReport } from "./report";

test("S smoke produces a validated synthetic report through the command seam in under 60 seconds", async () => {
  const out = mkdtempSync(join(tmpdir(), "kizuki-bench-test-"));
  const started = performance.now();
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), "--size", "S", "--out", out, "--smoke"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    deadline = setTimeout(() => child?.kill("SIGTERM"), 55_000);
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();
    expect(await child.exited, await stderr).toBe(0);
    expect(await stdout).toContain("report.json");
    const report = parseReport(JSON.parse(readFileSync(join(out, "report.json"), "utf8")));
    expect(report.schema).toBe("kizuki.benchmark/v1");
    expect(report.corpus.events).toBe(1_000);
    expect(report.corpus.canon_pages).toBeGreaterThan(0);
    expect(Object.keys(report.metrics).sort()).toEqual([...METRICS].sort());
    expect(report.metrics["serve.idle_cpu_percent"]?.status).toBe("omitted");
    expect(report.protocol).toMatchObject({ idle_warmup: "omitted", idle_repetitions: 0, idle_window_ms: 0, idle_observed_ms: [] });
    expect(Object.values(report.metrics).filter(metric => metric.status === "omitted")).toHaveLength(1);
    expect(readFileSync(join(out, "summary.md"), "utf8")).toContain(report.machine.git_sha);
    expect(JSON.parse(readFileSync(join(out, "report.schema.json"), "utf8")).properties.schema.const).toBe("kizuki.benchmark/v1");
    expect(() => parseReport({ ...report, private_text: "synthetic extra field" })).toThrow();
    expect(() => parseReport({ ...report, corpus: { ...report.corpus, events: 999 } })).toThrow();
    expect(() => parseReport({ ...report, metrics: { ...report.metrics, "doctor.wall_ms": { ...report.metrics["doctor.wall_ms"], p99: -1 } } })).toThrow();
    expect(performance.now() - started).toBeLessThan(60_000);
  } finally {
    clearTimeout(deadline);
    if (child?.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
