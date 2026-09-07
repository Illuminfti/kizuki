import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GITHUB_REPOSITORY_ID, inspectGithubCandidate, parseGithubEvidenceArgs } from "./github-release-evidence";

const SHA = "a".repeat(40);
const REPO = { id: GITHUB_REPOSITORY_ID, full_name: "fixture-owner/fixture-repo", private: false };
const CI = ".github/workflows/ci.yml", WORKFLOWS = ".github/workflows/workflows.yml";
const workflowText = new Map([CI, WORKFLOWS].map(path => [path, readFileSync(resolve(import.meta.dir, "..", path), "utf8")]));

function fixture() {
  const run = (id: number, path: string, workflow_id: number, run_number = 1, run_attempt = 1) => ({
    id, path, workflow_id, run_number, run_attempt, head_sha: SHA, head_commit: { id: SHA }, repository: { ...REPO }, head_repository: { ...REPO },
    run_started_at: new Date(Date.UTC(2026, 8, 7, 0, run_number)).toISOString().replace(".000Z", "Z"),
    event: "pull_request", status: "completed", conclusion: "success", created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:01:00Z",
  });
  const runs = [run(101, CI, 11), run(201, WORKFLOWS, 22)];
  const jobs = new Map<number, any[]>();
  const assignJobs = (r: ReturnType<typeof run>) => {
    const document = Bun.YAML.parse(workflowText.get(r.path)!) as any;
    jobs.set(r.id, Object.entries(document.jobs).map(([name, definition]: [string, any], offset) => ({
      id: r.id * 100 + offset, run_id: r.id, run_attempt: r.run_attempt, head_sha: SHA, name, status: "completed", conclusion: "success",
      steps: [{ name: "Set up job", number: 1, status: "completed", conclusion: "success" }, ...definition.steps.map((step: any, index: number) => ({
        name: step.name ?? `Run ${step.uses}`, number: index + 2, status: "completed", conclusion: "success",
      }))],
    })));
  };
  runs.forEach(assignJobs);
  const calls: string[] = [];
  const get = async (endpoint: string): Promise<any> => {
    calls.push(endpoint);
    const url = new URL(endpoint, "https://api.example.invalid"), page = Number(url.searchParams.get("page") ?? 1);
    let value: unknown;
    if (url.pathname === `/repositories/${GITHUB_REPOSITORY_ID}`) value = REPO;
    else if (url.pathname === `/repos/${REPO.full_name}/actions/runs`) value = {
      total_count: runs.length, workflow_runs: runs.slice((page - 1) * 25, page * 25),
    };
    else {
      const match = url.pathname.match(/\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(\/jobs)?$/);
      if (!match) throw new Error("unexpected synthetic endpoint");
      const selected = runs.find(row => row.id === Number(match[1]));
      if (!selected) throw new Error("missing synthetic run");
      value = match[3] ? { total_count: jobs.get(selected.id)!.length, jobs: jobs.get(selected.id)!.slice((page - 1) * 25, page * 25) }
        : match[2] ? { ...selected, run_attempt: Number(match[2]), run_started_at: new Date(Date.parse(selected.run_started_at) - (selected.run_attempt - Number(match[2])) * 1000).toISOString().replace(".000Z", "Z"), conclusion: Number(match[2]) < selected.run_attempt ? "failure" : selected.conclusion }
        : selected;
    }
    return structuredClone(value);
  };
  return { runs, jobs, calls, get, run, assignJobs };
}

test("current exact candidate CI and workflow jobs are independently bound", async () => {
  const f = fixture(), result = await inspectGithubCandidate(f.get, SHA, workflowText);
  expect(result.repository.id).toBe(GITHUB_REPOSITORY_ID);
  expect(result.required.map(row => row.status)).toEqual(["PASS", "PASS"]);
  expect(result.required.flatMap(row => row.jobs.map(job => job.name))).toEqual(["test", "secrets", "workflows"]);
  expect(result.attempts).toHaveLength(2);
  expect(f.calls.filter(path => path.includes("?head_sha="))).toHaveLength(2);
});

test("older failures are retained but cannot replace or veto a later successful run", async () => {
  const f = fixture(); f.runs[0]!.conclusion = "failure";
  const next = f.run(102, CI, 11, 2, 2); f.runs.push(next); f.assignJobs(next);
  const result = await inspectGithubCandidate(f.get, SHA, workflowText);
  expect(result.required[0]).toMatchObject({ status: "PASS", run: { id: 102, run_attempt: 2 } });
  expect(result.attempts).toContainEqual(expect.objectContaining({ run_id: 101, attempt: 1, status: "completed", conclusion: "failure" }));
  expect(result.attempts).toContainEqual(expect.objectContaining({ run_id: 102, attempt: 1, status: "completed", conclusion: "failure" }));
});

test.each(["failure", "cancelled", "timed_out", "neutral", "skipped"])("a newer %s attempt cannot borrow older green jobs", async conclusion => {
  const f = fixture(), next = f.run(102, CI, 11, 2); next.conclusion = conclusion; f.runs.push(next); f.assignJobs(next);
  expect((await inspectGithubCandidate(f.get, SHA, workflowText)).required[0]).toMatchObject({ status: "FAIL", run: { id: 102 } });
});

test("a newer pending run blocks current required checks", async () => {
  const f = fixture(), next = f.run(102, CI, 11, 2); next.status = "queued"; (next as any).conclusion = null;
  f.runs.push(next); f.assignJobs(next);
  expect((await inspectGithubCandidate(f.get, SHA, workflowText)).required[0]!.status).toBe("FAIL");
});

test.each([
  ["repository", (f: ReturnType<typeof fixture>) => { f.runs[0]!.repository.id = 1 as any; }],
  ["fork repository", (f: ReturnType<typeof fixture>) => { f.runs[0]!.head_repository.id = 1 as any; }],
  ["candidate", (f: ReturnType<typeof fixture>) => { f.runs[0]!.head_sha = "b".repeat(40); }],
  ["event", (f: ReturnType<typeof fixture>) => { f.runs[0]!.event = "workflow_dispatch"; }],
  ["job SHA", (f: ReturnType<typeof fixture>) => { f.jobs.get(101)![0].head_sha = "b".repeat(40); }],
  ["job attempt", (f: ReturnType<typeof fixture>) => { f.jobs.get(101)![0].run_attempt = 2; }],
  ["duplicate job", (f: ReturnType<typeof fixture>) => { f.jobs.get(101)!.push(f.jobs.get(101)![0]); }],
  ["duplicate run", (f: ReturnType<typeof fixture>) => { f.runs.push(f.runs[0]!); }],
] as const)("refuses %s mismatch", async (_name, mutate) => {
  const f = fixture(); mutate(f);
  await expect(inspectGithubCandidate(f.get, SHA, workflowText)).rejects.toThrow();
});

test("job names and each authored step must have actually succeeded", async () => {
  const renamed = fixture(); renamed.jobs.get(101)![0].name = "other";
  expect((await inspectGithubCandidate(renamed.get, SHA, workflowText)).required[0]!.status).toBe("FAIL");
  const skipped = fixture(); skipped.jobs.get(101)![0].steps[5].conclusion = "skipped";
  expect((await inspectGithubCandidate(skipped.get, SHA, workflowText)).required[0]!.status).toBe("FAIL");
  const spoofed = fixture(); spoofed.jobs.get(101)![0].steps[5].name = "different command";
  expect((await inspectGithubCandidate(spoofed.get, SHA, workflowText)).required[0]!.status).toBe("FAIL");
});

test("candidate workflow bytes must satisfy the current verifier", async () => {
  const f = fixture(), changed = new Map(workflowText);
  changed.set(CI, changed.get(CI)!.replace("bun run build:release", "echo substituted"));
  await expect(inspectGithubCandidate(f.get, SHA, changed)).rejects.toThrow("github-candidate-workflow-invalid");
});

test("all pages are collected and a truncated page cannot establish completeness", async () => {
  const f = fixture();
  for (let n = 2; n <= 26; n++) f.runs.push(f.run(200 + n, WORKFLOWS, 22, n));
  f.assignJobs(f.runs.at(-1)!);
  const result = await inspectGithubCandidate(f.get, SHA, workflowText);
  expect(result.inventory).toHaveLength(27);
  expect(f.calls.some(path => path.includes("head_sha=") && path.endsWith("page=2"))).toBe(true);
  await expect(inspectGithubCandidate(async endpoint => {
    const result = await f.get(endpoint);
    if (endpoint.includes("head_sha=") && endpoint.endsWith("page=1")) result.workflow_runs.pop();
    return result;
  }, SHA, workflowText)).rejects.toThrow("github-incomplete-inventory");
});

test("a new run or attempt during collection refuses the entire observation", async () => {
  for (const mode of ["run", "attempt"] as const) {
    const f = fixture(); let listings = 0;
    await expect(inspectGithubCandidate(async endpoint => {
      if (endpoint.includes("head_sha=") && ++listings === 2) {
        if (mode === "run") f.runs.push(f.run(102, CI, 11, 2));
        else f.runs[0]!.run_attempt++;
      }
      return f.get(endpoint);
    }, SHA, workflowText)).rejects.toThrow("github-inventory-changed");
  }
});

test("missing workflow is explicit and arbitrary saved-passing fields have no effect", async () => {
  const f = fixture(); f.runs.splice(1);
  const result = await inspectGithubCandidate(async endpoint => ({ ...await f.get(endpoint), passed: true, decision: "GO" }), SHA, workflowText);
  expect(result.required[1]).toMatchObject({ status: "MISSING", run: null });
});

test("online CLI has no endpoint, repository, run selector or saved-facts injection", () => {
  const args = ["--profile", "rc", "--evidence", "/tmp/index.json", "--checkout", "/tmp/candidate", "--out", "/tmp/receipt"];
  expect(parseGithubEvidenceArgs(args)).toEqual({ profile: "rc", evidence: "/tmp/index.json", checkout: "/tmp/candidate", out: "/tmp/receipt" });
  for (const flag of ["--repo", "--host", "--run", "--attempt", "--facts", "--passed"]) expect(() => parseGithubEvidenceArgs([...args, flag, "x"])).toThrow();
});


test.each(["success", "failure"])("an old run rerun started last controls current %s outcome", async conclusion => {
  const f = fixture(), next = f.run(102, CI, 11, 2); f.runs.push(next); f.assignJobs(next);
  f.runs[0]!.run_attempt = 2; f.runs[0]!.run_started_at = "2026-09-07T00:03:00Z"; f.runs[0]!.conclusion = conclusion; f.assignJobs(f.runs[0]!);
  const result = await inspectGithubCandidate(async endpoint => {
    const row = await f.get(endpoint);
    // Actual GitHub distinguishes original run creation from rerun creation.
    if (endpoint.endsWith("/101/attempts/2")) row.created_at = "2026-09-07T00:03:01Z";
    return row;
  }, SHA, workflowText);
  expect(result.required[0]).toMatchObject({ status: conclusion === "success" ? "PASS" : "FAIL", run: { id: 101, run_attempt: 2 } });
  expect(result.attempts).toContainEqual(expect.objectContaining({ run_id: 101, attempt: 1, conclusion: "failure" }));
});

test("a pending older-number run prevents credit even when another run started later", async () => {
  const f = fixture(); f.runs[0]!.status = "in_progress"; (f.runs[0] as any).conclusion = null;
  const next = f.run(102, CI, 11, 2); f.runs.push(next); f.assignJobs(next);
  expect((await inspectGithubCandidate(f.get, SHA, workflowText)).required[0]).toMatchObject({ status: "FAIL", reason: "github-required-attempt-pending" });
});

test.each(["missing", "invalid", "tie"])("%s attempt start cannot establish latest order", async mode => {
  const f = fixture(), next = f.run(102, CI, 11, 2); f.runs.push(next); f.assignJobs(next);
  if (mode === "tie") next.run_started_at = f.runs[0]!.run_started_at;
  else (next as any).run_started_at = mode === "missing" ? undefined : "2026-02-30T00:00:00Z";
  await expect(inspectGithubCandidate(f.get, SHA, workflowText)).rejects.toThrow();
});

test("end freshness rereads every latest attempt even if inventory and selected run stay unchanged", async () => {
  const f = fixture(), next = f.run(102, CI, 11, 2); f.runs.push(next); f.assignJobs(next); let count = 0;
  await expect(inspectGithubCandidate(async endpoint => {
    const value = await f.get(endpoint);
    if (endpoint.endsWith("/101/attempts/1") && ++count === 2) value.conclusion = "failure";
    return value;
  }, SHA, workflowText)).rejects.toThrow("github-attempt-changed");
});
