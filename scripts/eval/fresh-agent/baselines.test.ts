import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_ARMS, BASELINE_SCHEDULE, compareBaselines, runBaselineEvaluation, summarizeBaselines, parseBaselineReceipt } from "./baselines";
import type { BaselineReport } from "./baselines";

const root = mkdtempSync(join(tmpdir(), "quality-baselines-"));
let report: BaselineReport;
beforeAll(async () => { report = await runBaselineEvaluation({ out: join(root, "result") }); }, 120000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("fixed public baseline arms observe correction and revoke with no future or private evidence", () => {
  expect(report.rows).toHaveLength(18);
  for (const stage of BASELINE_SCHEDULE) for (const principal of ["owner", "scoped_agent"] as const) {
    expect(report.rows.filter(row => row.stage === stage && row.principal === principal).map(row => row.arm)).toEqual([...BASELINE_ARMS]);
  }
  for (const row of report.rows) {
    expect(row.status, JSON.stringify(row)).toBe("ok");
    expect(row.state_unchanged, JSON.stringify(row)).toBe(true);
    expect(row.tokens).toBeLessThanOrEqual(2000);
    expect(row.forbidden, JSON.stringify(row)).toBe(0);
    expect(row.future).toBe(0);
  }
  for (const stage of ["before_correction", "after_correction"] as const) {
    expect(report.rows.find(row => row.stage === stage && row.principal === "owner" && row.arm === "current_kizuki")).toMatchObject({ expected: 1, recalled: 1 });
  }
  expect(report.summary).toMatchObject({ observations: 18, failures: 0, hard_failures: 0 });
});

test("retained receipt contains fingerprints and bounded scores while the synthetic vault is removed", () => {
  const out = join(root, "result"), text = readFileSync(join(out, "report.json"), "utf8");
  expect(readdirSync(out)).toEqual(["report.json"]);
  expect(JSON.parse(text)).toEqual(report);
  for (const field of [report.source.source_sha256, report.corpus_sha256, report.config_sha256, report.schedule_sha256]) expect(field).toMatch(/^[0-9a-f]{64}$/);
  expect(report.source.commit).toMatch(/^[0-9a-f]{40}$/);
  for (const secret of ["Orchard", "Ada", "Grace", "paint samples", "load test", "restore the orchard footbridge", "persona:orchard", "vaultPath", "inputs/"]) expect(text).not.toContain(secret);
  for (const row of report.rows) expect(row.output_sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("a frozen current run remains a comparable baseline only under the same corpus and schedule", () => {
  const frozen = structuredClone(report); frozen.source.dirty = false;
  const next = structuredClone(frozen); next.source.commit = "a".repeat(40);
  expect(compareBaselines(frozen, next).rows.every(row => row.recall_delta === 0 && !row.hard_failure)).toBe(true);
  for (const key of ["corpus_sha256", "config_sha256", "schedule_sha256"] as const) {
    const altered = structuredClone(next); altered[key] = "b".repeat(64);
    expect(() => compareBaselines(frozen, altered)).toThrow("incompatible");
  }
  const dirty = structuredClone(next); dirty.source.dirty = true;
  expect(() => compareBaselines(frozen, dirty)).toThrow("incompatible");
  const missing = structuredClone(next); missing.rows.pop();
  expect(() => compareBaselines(frozen, missing)).toThrow("incompatible");
  const failed = structuredClone(next); failed.rows[0]!.status = "error"; failed.summary = summarizeBaselines(failed.rows);
  expect(compareBaselines(frozen, failed).rows).toHaveLength(18);
  expect(compareBaselines(frozen, failed).rows[0]!.status).toBe("error");
});

test("fixed schedule expected counts cannot be rewritten in imported receipts", () => {
  const frozen = structuredClone(report); frozen.source.dirty = false;
  // Remove the owner's required pre-correction fact, or invent a requirement
  // for a scoped agent that cannot read the private native correction.
  for (const [index, expected] of [[0, 0], [9, 1]] as const) {
    const altered = structuredClone(frozen);
    altered.rows[index]!.expected = expected;
    altered.rows[index]!.recalled = 0;
    altered.summary = summarizeBaselines(altered.rows);
    expect(() => parseBaselineReceipt(altered)).toThrow("incompatible");
    expect(() => compareBaselines(frozen, altered)).toThrow("incompatible");
  }
});

test("malformed receipts cannot copy private metadata or omit failures from comparisons", () => {
  const extra = { ...report, private_text: "private sentinel" };
  expect(() => parseBaselineReceipt(extra)).toThrow("incompatible");
  const reordered = structuredClone(report); reordered.rows.reverse();
  expect(() => parseBaselineReceipt(reordered)).toThrow("incompatible");
  const hidden = structuredClone(report); hidden.rows[0]!.status = "error";
  expect(() => parseBaselineReceipt(hidden)).toThrow("incompatible");
  const overflow = structuredClone(report); overflow.rows[0]!.tokens = 2001;
  expect(() => parseBaselineReceipt(overflow)).toThrow("incompatible");
});

test("public comparison refuses malformed or oversized input without echoing it", async () => {
  const frozen = structuredClone(report); frozen.source.dirty = false;
  const reference = join(root, "reference.json"), candidate = join(root, "candidate.json");
  writeFileSync(reference, JSON.stringify(frozen)); writeFileSync(candidate, JSON.stringify(frozen));
  const run = async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "baselines.ts"), "--compare", reference, candidate], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return {code,out,err};
  };
  const ok = await run(); expect(ok.code).toBe(0); expect(JSON.parse(ok.out).rows).toHaveLength(18); expect(ok.err).toBe("");
  for (const value of [JSON.stringify({ ...frozen, private_text: "private sentinel" }), "private sentinel".repeat(5000)]) {
    writeFileSync(candidate, value);
    const denied = await run(); expect(denied.code).toBe(1); expect(denied.out).toBe(""); expect(denied.err).toBe("Quality baseline evaluation failed.\n");
  }
}, 30000);
