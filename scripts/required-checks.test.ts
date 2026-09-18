import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateCommittedAt, p0DispositionReceipt } from "./p0-disposition";
import { requiredChecksContexts, requiredChecksReceipt } from "./required-checks";
import {
  EVALUATOR_ROOT, EvidenceError, P0_LABEL, REQUIRED_CONTEXTS,
  consumeP0DispositionReceipt, consumeRequiredChecksReceipt, receiptInstant,
} from "./release-evidence";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = "a".repeat(40);
const attempt_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const recorded_at = "2026-09-18T00:30:00.000Z";

function observedWorkflows(patch: { conclusion?: string; drop?: string } = {}) {
  const job = (name: string) => ({ name, conclusion: name === patch.drop ? null : patch.conclusion ?? "success" });
  return [
    { path: ".github/workflows/ci.yml", run: { id: 101, updated_at: "2026-09-18T00:20:00Z" }, jobs: [job("test"), job("secrets")] },
    { path: ".github/workflows/workflows.yml", run: { id: 201, updated_at: "2026-09-18T00:25:00Z" }, jobs: [job("workflows")] },
  ];
}
function reasonOf(run: () => unknown): string {
  try { run(); throw new Error("expected throw"); }
  catch (error) {
    expect(error).toBeInstanceOf(EvidenceError);
    return (error as EvidenceError).reason;
  }
}
function syntheticRepo() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-candidate-commit-")); roots.push(root);
  const git = (args: string[]) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  git(["-c", "init.defaultBranch=main", "init"]);
  writeFileSync(join(root, "README"), "synthetic candidate\n");
  git(["add", "."]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "synthetic candidate"]);
  return { root, sha: git(["rev-parse", "HEAD"]) };
}

test("required contexts are projected in their required order with run identity", () => {
  expect(requiredChecksContexts(observedWorkflows())).toEqual([
    { context: "test", conclusion: "success", run_id: 101, completed_at: "2026-09-18T00:20:00.000Z" },
    { context: "secrets", conclusion: "success", run_id: 101, completed_at: "2026-09-18T00:20:00.000Z" },
    { context: "workflows", conclusion: "success", run_id: 201, completed_at: "2026-09-18T00:25:00.000Z" },
  ]);
  expect(requiredChecksContexts(observedWorkflows()).map(row => row.context)).toEqual([...REQUIRED_CONTEXTS]);
});

test("an unobserved, unconcluded or duplicated required context is refused", () => {
  expect(reasonOf(() => requiredChecksContexts(observedWorkflows().slice(0, 1)))).toBe("required-context-unobserved");
  expect(reasonOf(() => requiredChecksContexts([{ ...observedWorkflows()[0]!, run: null }, observedWorkflows()[1]!]))).toBe("required-context-unobserved");
  expect(reasonOf(() => requiredChecksContexts(observedWorkflows({ drop: "secrets" })))).toBe("required-context-unresolved");
  expect(reasonOf(() => requiredChecksContexts([...observedWorkflows(), observedWorkflows()[1]!]))).toBe("required-context-duplicate");
  expect(reasonOf(() => receiptInstant("2026-02-30T99:00:00Z"))).toBe("invalid-recorded-at");
});

test("an emitted required-checks receipt passes the evaluator on this checkout", () => {
  const receipt = requiredChecksReceipt({ candidate_source_sha: source, root: EVALUATOR_ROOT, contexts: requiredChecksContexts(observedWorkflows()), attempt_id, recorded_at });
  expect(consumeRequiredChecksReceipt(receipt, EVALUATOR_ROOT, source)).toEqual({
    status: "PASS", reason: "exact-candidate-required-checks-passed", creditDigest: true,
  });
  expect(JSON.stringify(receipt)).toBe(JSON.stringify(requiredChecksReceipt({
    candidate_source_sha: source, root: EVALUATOR_ROOT, contexts: requiredChecksContexts(observedWorkflows()), attempt_id, recorded_at,
  })));
  const red = requiredChecksReceipt({ candidate_source_sha: source, root: EVALUATOR_ROOT, contexts: requiredChecksContexts(observedWorkflows({ conclusion: "failure" })), attempt_id, recorded_at });
  expect(consumeRequiredChecksReceipt(red, EVALUATOR_ROOT, source)).toMatchObject({ status: "FAIL", reason: "required-context-not-successful" });
  expect(reasonOf(() => consumeRequiredChecksReceipt(receipt, EVALUATOR_ROOT, "b".repeat(40)))).toBe("candidate-mismatch");
});

test("candidate commit time comes from a checkout that holds the candidate", () => {
  const repo = syntheticRepo();
  const committed = candidateCommittedAt(repo.root, repo.sha);
  expect(committed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  expect(reasonOf(() => candidateCommittedAt(repo.root, source))).toBe("candidate-commit-time-unavailable");
  expect(reasonOf(() => candidateCommittedAt(repo.root, "not-a-sha"))).toBe("invalid-digest");
});

test("an emitted p0-disposition receipt records the queried label and passes when clear", () => {
  const repo = syntheticRepo();
  const input = {
    candidate_source_sha: source, root: EVALUATOR_ROOT, candidate_committed_at: candidateCommittedAt(repo.root, repo.sha),
    snapshot_at: new Date().toISOString(), open_issues: [] as { number: number; updated_at: string }[], attempt_id, recorded_at,
  };
  const receipt = p0DispositionReceipt(input);
  expect(receipt.label).toBe(P0_LABEL);
  expect(consumeP0DispositionReceipt(receipt, EVALUATOR_ROOT, source)).toEqual({
    status: "PASS", reason: "current-p0-inventory-clear", creditDigest: true,
  });
  expect(JSON.stringify(receipt)).toBe(JSON.stringify(p0DispositionReceipt(input)));
  const open = p0DispositionReceipt({ ...input, open_issues: [{ number: 12, updated_at: "2026-09-18T00:00:00Z" }] });
  expect(consumeP0DispositionReceipt(open, EVALUATOR_ROOT, source)).toMatchObject({ status: "FAIL", reason: "current-p0-findings-open:12" });
});
