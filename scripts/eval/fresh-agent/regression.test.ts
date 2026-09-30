import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AS_OF } from "./persona";
import type { EvaluationReport } from "./run";

async function runFixture(mode: string, root: string, hostTime?: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "regression-fixture.ts"), mode, root, ...(hostTime === undefined ? [] : [hostTime])], {
    stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: true,
  });
  // This group contains only the driver and its benchmark child. A timed-out
  // driver must not leave the worker running after the test deletes its vault.
  const stop = () => {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const deadline = setTimeout(stop, 110_000);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(error).toBe("");
    expect(code).toBe(mode === "unavailable" ? 1 : 0);
    return { code, data: JSON.parse(readFileSync(join(root, "regression.json"), "utf8")) };
  } finally {
    clearTimeout(deadline);
    stop();
    await child.exited;
  }
}

test("fresh evaluations preserve semantic scores and native timestamps under shifted host dates", async () => {
  const root = mkdtempSync(join(tmpdir(), "fresh-agent-clock-"));
  try {
    const reports: EvaluationReport[] = [];
    for (const [index, hostTime] of [AS_OF, "2026-12-01T12:00:00.000Z"].entries()) {
      const { code, data } = await runFixture("host", join(root, `run-${index}`), hostTime);
      expect(code).toBe(0);
      expect(data.caller_time).toBe(hostTime);
      expect(data.corrections.length).toBeGreaterThan(0);
      for (const correction of data.corrections) expect(correction).toEqual({ created_at: AS_OF, asserted_at: AS_OF, valid_from: AS_OF });
      expect(data.receipts.length).toBeGreaterThan(0);
      expect(data.receipts.every((at: string) => at === AS_OF)).toBe(true);
      const report = data.report as EvaluationReport;
      expect(report.as_of).toBe(AS_OF);
      for (const { surface, observation } of report.observations) {
        if (surface === "session_hook") expect(observation.output).toContain(`at=${AS_OF}`);
        else if (surface === "context_packet" || surface === "search") expect(JSON.parse(observation.output).at).toBe(AS_OF);
        else for (const envelope of JSON.parse(observation.output)) expect(envelope.at).toBe(AS_OF);
      }
      reports.push(report);
    }
    // Core mints random opaque references, whose tokenization is measured separately.
    const semanticRows = (report: EvaluationReport) => report.rows.map(({ tokens_used, ...row }) => row);
    expect(semanticRows(reports[1]!)).toEqual(semanticRows(reports[0]!));
    const around = reports[0]!.rows.find(row => row.principal === "owner" && row.surface === "session_hook" && row.question_id === "around")!;
    expect(around).toMatchObject({ recalled: 3, expected: 3 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test("unavailable packets fail observation, summary and the command exit gate; usable fallbacks remain measured", async () => {
  const root = mkdtempSync(join(tmpdir(), "fresh-agent-unavailable-"));
  try {
    const { code, data } = await runFixture("unavailable", root);
    expect(code).toBe(1);
    expect(data.statuses).toEqual(["skip:unavailable", "skip:unavailable", "ok", "truncated"]);
    expect(data.fallback.data.retrieval_degraded).not.toContain("context-unavailable");
    expect(data.observation.status).toBe("skip:unavailable");
    expect(JSON.parse(data.observation.output).data.retrieval_degraded).toContain("context-unavailable");
    expect(data.summaries.find((row: { principal: string; surface: string }) => row.principal === "owner" && row.surface === "context_packet").failures).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
