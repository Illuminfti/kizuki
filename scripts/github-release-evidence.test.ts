import { lifecycleFixture } from "./native-lifecycle-proof-fixture";
import { LIFECYCLE_PRODUCER_ENTRYPOINTS, LIFECYCLE_PRODUCER_DATA } from "./native-lifecycle-proof";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectProductSources } from "./release-evidence";
import { createHash } from "node:crypto";
import { writePackageFixture } from "./release-package-fixture";
import { checksumManifest, CURRENT_PACKAGE_FILES } from "./release-artifacts";
import { artifactProofSteps, SQLITE_ENGINE_POLICY } from "./artifact-proof";
import { distributionIdentity } from "./release-notices";
import { verifyGithubNativeArchive } from "./github-native-artifact";
import { evaluateRelease } from "./go-no-go";
import { resolve } from "node:path";
import { GITHUB_REPOSITORY_ID, inspectGithubCandidate, inspectGithubNativeArtifacts, inspectGithubNativeJobs, inspectGithubNativeIndexBinding, validateGithubCommandBindings, bindGithubNativeProducer, bindGithubLifecycleProducer, inspectGithubLifecycleIndexBinding, parseGithubEvidenceArgs, inspectGithubCurrentP0, inspectGithubP0Disposition } from "./github-release-evidence";

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
  for (const flag of ["--repo", "--host", "--run", "--attempt", "--facts", "--passed", "--label", "--p0"]) expect(() => parseGithubEvidenceArgs([...args, flag, "x"])).toThrow();
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


const nativeRoots: string[] = [];
afterEach(() => { for (const root of nativeRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function syntheticArchive(target: string, mode = "valid") {
  const root = mkdtempSync(join(tmpdir(), "kizuki-github-native-")); nativeRoots.push(root);
  const directory = join(root, "package"); mkdirSync(directory);
  const build = writePackageFixture(directory, SHA, target);
  if (mode === "different-package") writeFileSync(join(directory, "kizuki"), "Different synthetic executable, same source revision. Never executed.\n");
  if (mode === "different-build") writeFileSync(join(directory, "BUILD.json"), JSON.stringify(build, null, 2) + "\n");
  if (mode === "different-package" || mode === "different-build") writeFileSync(join(directory, "SHA256SUMS"), checksumManifest(directory, CURRENT_PACKAGE_FILES.slice(0, -1)));
  const package_sha256 = Object.fromEntries(CURRENT_PACKAGE_FILES.map(name => [name, digest(readFileSync(join(directory, name)))]));
  const paths = { executable: "/tmp/kizuki-artifact-proof-synthetic/artifact/kizuki", home: "/tmp/kizuki-artifact-proof-synthetic/execution/home",
    config: "/tmp/kizuki-artifact-proof-synthetic/execution/config/kizuki.toml", vault: "/tmp/kizuki-artifact-proof-synthetic/execution/vault", restored_vault: "/tmp/kizuki-artifact-proof-synthetic/execution/restored" };
  const engine = SQLITE_ENGINE_POLICY.accepted[0];
  const runtime = { schema: "kizuki.sqlite-runtime/v1", bun_version: "1.3.14", sqlite_version: engine.sqlite_version, sqlite_source_id: engine.sqlite_source_id };
  const proof: any = { schema: "kizuki.artifact-proof/v3", source_sha: SHA, target, host_platform: target.includes("linux") ? "linux" : "darwin", host_arch: target.includes("linux") ? "x64" : "arm64",
    host_kernel_release: "synthetic-kernel", binary_sha256: package_sha256.kizuki, bun_version: "1.3.14", package_sha256, paths, distribution_identity: distributionIdentity(build.distribution),
    steps: artifactProofSteps("kizuki.artifact-proof/v3", paths).map(step => ({ ...step, passed: true, exit_code: 0 })), failures: [],
    engine_observations: { kizuki: { executable_sha256: package_sha256.kizuki, runtime, exit_code: 0, doctor_status: "ok" }, kizuki_mcp: { executable_sha256: package_sha256["kizuki-mcp"], runtime, exit_code: 0, mcp_is_error: false } } };
  if (mode === "wrong-host") proof.host_arch = "wrong";
  if (mode === "skipped-proof") proof.steps[2].passed = false;
  if (mode === "legacy-proof") proof.schema = "kizuki.artifact-proof/v2";
  if (mode === "different-proof") proof.host_kernel_release = "different-synthetic-kernel";
  writeFileSync(join(root, "proof.json"), JSON.stringify(proof));
  const lifecycle = mode.startsWith("lifecycle-") ? lifecycleFixture({ source_sha: SHA, target, bun_version: "1.3.14", package_sha256 }) : { diagnostic: "synthetic only" };
  if (mode.startsWith("lifecycle-")) {
    for (const p of lifecycle.qualification.phases) if (p.id.startsWith("model-")) { p.evidence.started_at = "2026-09-07T00:03:00Z"; if (p.evidence.recovery) { p.evidence.recovery.started_at = "2026-09-07T00:04:00Z"; p.evidence.recovery.receipt_due_at = p.evidence.recovery.scheduling_override.next = "2026-09-07T00:03:59.000Z"; } }
    if (mode === "lifecycle-forged") lifecycle.qualification.phases[0].evidence.public_doctor_ok = false;
    if (mode === "lifecycle-stale") lifecycle.qualification.phases.at(-1).evidence.started_at = "2026-09-07T00:01:00Z";
  }
  writeFileSync(join(root, "lifecycle.json"), JSON.stringify(lifecycle));
  const archive = join(root, "input.zip");
  execFileSync("python3", ["-c", `import pathlib,sys,zipfile,stat
root=pathlib.Path(sys.argv[1]); target=sys.argv[2]; mode=sys.argv[3]
items=[('repo/repo/dist/kizuki-0.1.0/'+target+'/'+p.name,p.read_bytes()) for p in (root/'package').iterdir()]
items += [('_temp/kizuki-native-artifact-proof/receipt.json',(root/'proof.json').read_bytes()),('_temp/kizuki-native-service-lifecycle/receipt.json',(root/'lifecycle.json').read_bytes())]
if mode=='extra': items.append(('unexpected',b'x'))
if mode=='duplicate': items.append(items[0])
if mode=='missing': items.pop()
if mode=='traversal': items[0]=('../escape',items[0][1])
if mode=='absolute': items[0]=('/escape',items[0][1])
if mode=='oversize': items=[(n,b'x'*65537 if n.endswith('/README.txt') else b) for n,b in items]
with zipfile.ZipFile(root/'input.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
 for i,(name,body) in enumerate(items):
  entry=zipfile.ZipInfo(name); entry.compress_type=zipfile.ZIP_DEFLATED
  if mode=='symlink' and i==0: entry.create_system=3; entry.external_attr=(stat.S_IFLNK|0o777)<<16
  z.writestr(entry,body)
`, root, target, mode], { stdio: ["ignore", "ignore", "pipe"] });
  let bytes = readFileSync(archive);
  if (mode === "truncated") { bytes = bytes.subarray(0, bytes.length - 5); writeFileSync(archive, bytes); }
  return { root, archive, bytes, output: join(root, "unpacked") };
}

test.each(["bun-linux-x64-baseline", "bun-darwin-arm64"])("closed native %s archive validates actual seven package bytes without executing them", target => {
  const f = syntheticArchive(target), result = verifyGithubNativeArchive(f.archive, f.output, target, SHA, "1.3.14");
  expect(result.archive_sha256).toBe(digest(f.bytes));
  expect(Object.keys(result.package_sha256).sort()).toEqual([...CURRENT_PACKAGE_FILES].sort());
  expect(result.lifecycle.release_credit).toBe(false);
});

test.each(["extra", "duplicate", "missing", "traversal", "absolute", "oversize", "symlink", "truncated", "wrong-host", "skipped-proof", "legacy-proof"])("native archive refuses %s", mode => {
  const f = syntheticArchive("bun-linux-x64-baseline", mode);
  expect(() => verifyGithubNativeArchive(f.archive, f.output, "bun-linux-x64-baseline", SHA, "1.3.14")).toThrow();
});

function nativeFixture(mode = "valid") {
  const f = fixture(), path = ".github/workflows/macos-native.yml", text = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
  const selected = f.run(301, path, 33); selected.event = "workflow_dispatch"; f.runs.splice(0, f.runs.length, selected);
  const steps = (Bun.YAML.parse(text) as any).jobs["native-service"].steps;
  const archives = new Map<number, ReturnType<typeof syntheticArchive>>();
  const artifacts: any[] = [];
  const jobs = ["ubuntu-24.04", "macos-15"].map((os, index) => {
    const archive = syntheticArchive(index === 0 ? "bun-linux-x64-baseline" : "bun-darwin-arm64", mode); archives.set(index + 401, archive);
    artifacts.push({ id: index + 401, name: `native-service-lifecycle-${os}-${SHA}`, size_in_bytes: archive.bytes.length, digest: `sha256:${digest(archive.bytes)}`, expired: false,
      created_at: "2026-09-07T00:05:01Z", updated_at: "2026-09-07T00:05:01Z", expires_at: "2026-09-14T00:05:01Z",
      workflow_run: { id: 301, repository_id: REPO.id, head_repository_id: REPO.id, head_sha: SHA } });
    return { id: index + 30100, run_id: 301, run_attempt: 1, head_sha: SHA, name: `native-service (${os})`, status: "completed", conclusion: "success",
      labels: [os], runner_id: index + 1001, runner_group_id: 0, runner_group_name: "GitHub Actions", started_at: "2026-09-07T00:02:00Z", completed_at: "2026-09-07T00:06:00Z",
      steps: [{ name: "Set up job", number: 1, status: "completed", conclusion: "success" }, ...steps.map((step: any, offset: number) => ({
        name: step.name ?? `Run ${step.uses}`, number: offset + 2, status: "completed", conclusion: os === "macos-15" && step.if === "${{ runner.os == 'Linux' }}" ? "skipped" : "success",
        started_at: "2026-09-07T00:05:00Z", completed_at: "2026-09-07T00:05:01Z",
      }))] };
  });
  f.jobs.set(301, [...jobs, { id: 30102, run_id: 301, run_attempt: 1, head_sha: SHA, name: "native-arm64", status: "completed", conclusion: "skipped", steps: [] }]);
  const get = async (endpoint: string) => {
    if (endpoint.includes("/artifacts")) {
      const match = endpoint.match(/\/artifacts\/(\d+)$/);
      return structuredClone(match ? artifacts.find(row => row.id === Number(match[1])) : { total_count: artifacts.length, artifacts });
    }
    return f.get(endpoint);
  };
  let downloads = 0;
  const download = async (endpoint: string) => { downloads++; return archives.get(Number(endpoint.match(/\/artifacts\/(\d+)\/zip$/)![1]))!.bytes; };
  const output = join(archives.get(401)!.root, "collection"); mkdirSync(output);
  return { ...f, text, selected, nativeJobs: jobs, artifacts, get, download, output, downloads: () => downloads };
}

test("same successful native matrix attempt binds both digests and leaves lifecycle uncredited", async () => {
  const f = nativeFixture(), result = await inspectGithubNativeArtifacts(f.get, f.download, SHA, f.text, "1.3.14", f.output);
  expect(result.status).toBe("PASS"); expect(result.targets).toHaveLength(2); expect(f.downloads()).toBe(2);
  expect(result.targets.every(row => row.bytes.lifecycle.release_credit === false)).toBe(true);
});

function indexedNativeReport(output: string, targets: Awaited<ReturnType<typeof inspectGithubNativeArtifacts>>["targets"]) {
  const index = join(output, "index.json");
  writeFileSync(index, JSON.stringify({ schema: "kizuki.acceptance-evidence/v4", candidate_source_sha: SHA, fixture_observation: null, gate_receipts: [],
    artifacts: targets.map(row => ({ producer: "kizuki.artifact-proof/v3", target: row.target,
      directory: join(output, row.target, "package"), proof: join(output, row.target, "artifact-proof.json"), proof_sha256: row.bytes.proof_sha256 })) }));
  return evaluateRelease("rc", index);
}

test("paired native credit requires the same independently indexed seven-file packages without granting engine credit", async () => {
  const f = nativeFixture(), result = await inspectGithubNativeArtifacts(f.get, f.download, SHA, f.text, "1.3.14", f.output);
  const missing = indexedNativeReport(f.output, []);
  expect(inspectGithubNativeIndexBinding(result.targets, missing.evidence)).toEqual({ status: "UNVERIFIABLE", reason: "github-native-package-not-indexed" });
  expect(missing.gates.filter(row => row.id.startsWith("engine.")).every(row => row.status === "MISSING")).toBe(true);
  const report = indexedNativeReport(f.output, result.targets), before = JSON.stringify(report);
  expect(report.evidence).toHaveLength(2);
  expect(report.evidence.every(row => row.engine.status === "PASS")).toBe(true);
  expect(inspectGithubNativeIndexBinding(result.targets, report.evidence).status).toBe("PASS");
  expect(inspectGithubNativeIndexBinding(result.targets, [report.evidence[0]!]).status).toBe("UNVERIFIABLE");
  expect(JSON.stringify(report)).toBe(before);
});

test.each(["different-package", "different-build", "different-proof"])("same-source %s cannot mix indexed package evidence with the fresh native bytes", async mode => {
  const f = nativeFixture(), result = await inspectGithubNativeArtifacts(f.get, f.download, SHA, f.text, "1.3.14", f.output);
  const alternate = syntheticArchive(result.targets[0]!.target, mode);
  const bytes = verifyGithubNativeArchive(alternate.archive, alternate.output, result.targets[0]!.target, SHA, "1.3.14");
  const index = join(alternate.root, "index.json");
  writeFileSync(index, JSON.stringify({ schema: "kizuki.acceptance-evidence/v4", candidate_source_sha: SHA, fixture_observation: null, gate_receipts: [], artifacts: [
    { producer: "kizuki.artifact-proof/v3", target: bytes.target, directory: join(alternate.output, "package"), proof: join(alternate.output, "artifact-proof.json"), proof_sha256: bytes.proof_sha256 },
    { producer: "kizuki.artifact-proof/v3", target: result.targets[1]!.target, directory: join(f.output, result.targets[1]!.target, "package"),
      proof: join(f.output, result.targets[1]!.target, "artifact-proof.json"), proof_sha256: result.targets[1]!.bytes.proof_sha256 },
  ] }));
  const report = evaluateRelease("rc", index);
  expect(report.evidence).toHaveLength(2);
  expect(report.evidence.every(row => row.engine.status === "PASS")).toBe(true);
  expect(inspectGithubNativeIndexBinding(result.targets, report.evidence)).toEqual({ status: "FAIL", reason: "github-native-index-package-mismatch" });
});

test("index binding checks every member and refuses swapped proofs or targets", async () => {
  const f = nativeFixture(), result = await inspectGithubNativeArtifacts(f.get, f.download, SHA, f.text, "1.3.14", f.output);
  const report = indexedNativeReport(f.output, result.targets);
  for (const name of CURRENT_PACKAGE_FILES) {
    const changed = structuredClone(report.evidence); changed[0]!.package_sha256[name] = "f".repeat(64);
    expect(inspectGithubNativeIndexBinding(result.targets, changed).status).toBe("FAIL");
  }
  const proofSwap = structuredClone(report.evidence);
  [proofSwap[0]!.proof_sha256, proofSwap[1]!.proof_sha256] = [proofSwap[1]!.proof_sha256, proofSwap[0]!.proof_sha256];
  expect(inspectGithubNativeIndexBinding(result.targets, proofSwap).status).toBe("FAIL");
  const targetSwap = structuredClone(report.evidence);
  [targetSwap[0]!.target, targetSwap[1]!.target] = [targetSwap[1]!.target, targetSwap[0]!.target];
  expect(inspectGithubNativeIndexBinding(result.targets, targetSwap).status).toBe("FAIL");
  expect(inspectGithubNativeIndexBinding(result.targets, [...report.evidence, report.evidence[0]!]).status).toBe("FAIL");
  expect(inspectGithubNativeIndexBinding([result.targets[0]!, result.targets[0]!], report.evidence).status).toBe("FAIL");
  const oneMissingOneMismatch = structuredClone(report.evidence.slice(1)); oneMissingOneMismatch[0]!.proof_sha256 = "f".repeat(64);
  expect(inspectGithubNativeIndexBinding(result.targets, oneMissingOneMismatch).status).toBe("FAIL");
});

test.each(["old-upload", "wrong-digest", "wrong-repository", "wrong-run", "missing-artifact", "wrong-runner", "mixed-attempt"])("native API refuses %s", async mode => {
  const f = nativeFixture();
  if (mode === "old-upload") f.artifacts[0].created_at = "2026-09-07T00:00:00Z";
  if (mode === "wrong-digest") f.artifacts[0].digest = `sha256:${"0".repeat(64)}`;
  if (mode === "wrong-repository") f.artifacts[0].workflow_run.repository_id = 1;
  if (mode === "wrong-run") f.artifacts[0].workflow_run.id = 302;
  if (mode === "missing-artifact") f.artifacts.pop();
  if (mode === "wrong-runner") f.nativeJobs[0]!.runner_group_id = 1;
  if (mode === "mixed-attempt") f.nativeJobs[1]!.run_attempt = 2;
  await expect(inspectGithubNativeArtifacts(f.get, f.download, SHA, f.text, "1.3.14", f.output)).rejects.toThrow();
});

test("failed paired native run cannot borrow its one successful target or download bytes", async () => {
  const f = nativeFixture(); f.selected.conclusion = "failure"; f.nativeJobs[1]!.conclusion = "failure";
  const result = await inspectGithubNativeArtifacts(f.get, f.download, SHA, f.text, "1.3.14", f.output);
  expect(result.status).toBe("FAIL"); expect(result.targets).toEqual([]); expect(f.downloads()).toBe(0);
});

test.each(["artifact", "job", "attempt"])("native %s change during download invalidates credit", async mode => {
  const f = nativeFixture(); let mutated = false;
  const download = async (endpoint: string) => {
    const bytes = await f.download(endpoint);
    if (!mutated) {
      mutated = true;
      if (mode === "artifact") f.artifacts[0].updated_at = "2026-09-07T00:05:02Z";
      if (mode === "job") f.nativeJobs[0]!.runner_id++;
      if (mode === "attempt") f.selected.run_attempt++;
    }
    return bytes;
  };
  await expect(inspectGithubNativeArtifacts(f.get, download, SHA, f.text, "1.3.14", f.output)).rejects.toThrow();
});


test("archive inspection ignores Python module and site injection from caller environment", () => {
  const f = syntheticArchive("bun-linux-x64-baseline"), marker = join(f.root, "injected");
  writeFileSync(join(f.root, "zipfile.py"), `open(${JSON.stringify(marker)}, "w").write("injected")\nraise RuntimeError("wrong module")\n`);
  const child = Bun.spawnSync([process.execPath, "--eval", `import {verifyGithubNativeArchive} from ${JSON.stringify(join(import.meta.dir, "github-native-artifact.ts"))};
    const result=verifyGithubNativeArchive(${JSON.stringify(f.archive)},${JSON.stringify(f.output)},"bun-linux-x64-baseline",${JSON.stringify(SHA)},"1.3.14");console.log(result.archive_sha256);`], {
    cwd: f.root, env: { ...process.env, PYTHONPATH: f.root }, stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0); expect(child.stdout.toString().trim()).toBe(digest(f.bytes)); expect(existsSync(marker)).toBe(false);
});


test.each(["verify", "typecheck", "build:release", "smoke:release", "proof:artifact"])("candidate package command %s cannot substitute execution behind a green job name", name => {
  const reviewed = readFileSync(resolve(import.meta.dir, "../package.json")), candidate = JSON.parse(reviewed.toString());
  expect(validateGithubCommandBindings(reviewed, reviewed)).toHaveLength(5);
  candidate.scripts[name] = "echo synthetic replacement";
  expect(() => validateGithubCommandBindings(Buffer.from(JSON.stringify(candidate)), reviewed)).toThrow("github-candidate-command-mismatch");
  candidate.scripts[name] = JSON.parse(reviewed.toString()).scripts[name];
  candidate.scripts["pre" + name] = "echo synthetic hook";
  expect(() => validateGithubCommandBindings(Buffer.from(JSON.stringify(candidate)), reviewed)).toThrow("github-candidate-command-mismatch");
});


function producerFixture(lifecycle = false) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-github-producer-")); nativeRoots.push(root);
  const source = resolve(import.meta.dir, "..");
  const graph = collectProductSources(source, ["scripts/stranger-proof.ts", "scripts/build-release.ts", "scripts/smoke-release.ts"]);
  const paths = [...new Set([...graph.bindings.map(file => file.path), ".bun-version", "bun.lock", "tsconfig.json"])];
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd: string) => { git(cwd, ["add", "-f", "."]); git(cwd, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "synthetic producer custody"]); return git(cwd, ["rev-parse", "HEAD"]); };
  const repos = ["reviewed", "candidate"].map(name => {
    const path = join(root, name); mkdirSync(path);
    for (const file of paths) { mkdirSync(dirname(join(path, file)), { recursive: true }); writeFileSync(join(path, file), readFileSync(join(source, file))); }
    if (lifecycle) {
      for (const entry of LIFECYCLE_PRODUCER_ENTRYPOINTS) { mkdirSync(dirname(join(path, entry)), { recursive: true }); writeFileSync(join(path, entry), 'import "./synthetic-lifecycle-leaf";\nexport const synthetic = true;\n'); }
      writeFileSync(join(path, "scripts/synthetic-lifecycle-leaf.ts"), "export const observed = true;\n");
      for (const entry of LIFECYCLE_PRODUCER_DATA) { mkdirSync(dirname(join(path, entry)), { recursive: true }); writeFileSync(join(path, entry), readFileSync(join(source, entry))); }
    }
    git(path, ["-c", "init.defaultBranch=main", "init"]);
    return { path, sha: commit(path) };
  });
  return { reviewed: repos[0]!, candidate: repos[1]!, commit };
}

test.each(["scripts/stranger-proof.ts", "scripts/artifact-engine.ts"])("a clean candidate cannot replace reviewed native producer %s", path => {
  const f = producerFixture();
  const held = bindGithubNativeProducer(f.candidate.path, f.candidate.sha, f.reviewed.path, f.reviewed.sha);
  expect(held.candidate_files).toEqual(held.reviewed_files);
  writeFileSync(join(f.candidate.path, path), readFileSync(join(f.candidate.path, path), "utf8") + "\n// changed producer implementation\n");
  f.candidate.sha = f.commit(f.candidate.path);
  expect(() => bindGithubNativeProducer(f.candidate.path, f.candidate.sha, f.reviewed.path, f.reviewed.sha)).toThrow("github-native-producer-unreviewed");
  expect(() => held.unchanged()).toThrow();
});

test("native producer equality permits separate product-under-test changes", () => {
  const f = producerFixture(), path = join(f.candidate.path, "packages/cli/src/main.ts"); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "// synthetic product-under-test variation; never executed\n"); f.candidate.sha = f.commit(f.candidate.path);
  const held = bindGithubNativeProducer(f.candidate.path, f.candidate.sha, f.reviewed.path, f.reviewed.sha);
  expect(held.candidate_files).toEqual(held.reviewed_files); expect(() => held.unchanged()).not.toThrow();
});


test("run and attempt resource update times may differ while each remains stable", async () => {
  const f = fixture();
  const result = await inspectGithubCandidate(async endpoint => {
    const row = await f.get(endpoint);
    if (endpoint.endsWith("/attempts/1")) row.updated_at = "2026-09-07T00:01:01Z";
    return row;
  }, SHA, workflowText);
  expect(result.required.map(row => row.status)).toEqual(["PASS", "PASS"]);
  expect(result.attempts.every(row => row.updated_at === "2026-09-07T00:01:01Z")).toBe(true);
});

test("an attempt resource update during collection still fails freshness", async () => {
  const f = fixture(); let reads = 0;
  await expect(inspectGithubCandidate(async endpoint => {
    const row = await f.get(endpoint);
    if (endpoint.endsWith("/101/attempts/1") && ++reads === 2) row.updated_at = "2026-09-07T00:01:01Z";
    return row;
  }, SHA, workflowText)).rejects.toThrow("github-attempt-changed");
});


test("v2 paired lifecycle consistency requires same indexed bytes and still leaves offline lifecycle uncredited", async () => {
  const f = nativeFixture("lifecycle-valid"), result = await inspectGithubNativeArtifacts(f.get, f.download, SHA, f.text, "1.3.14", f.output);
  const report = indexedNativeReport(f.output, result.targets);
  expect(result.targets.every(row => row.bytes.lifecycle.facts?.status === "PASS" && row.bytes.lifecycle.release_credit === false)).toBe(true);
  expect(inspectGithubLifecycleIndexBinding(result.targets, report.evidence)).toEqual({ status: "PASS", reason: "github-current-native-candidate-lifecycle" });
  expect(inspectGithubLifecycleIndexBinding(result.targets, []).status).toBe("UNVERIFIABLE");
  expect(report.gates.filter(row => row.id.startsWith("lifecycle.")).every(row => row.status !== "PASS")).toBe(true);
  expect(report.decision).not.toBe("GO");
  const modified = structuredClone(report.evidence); modified[0]!.package_sha256.kizuki = "f".repeat(64);
  expect(inspectGithubLifecycleIndexBinding(result.targets, modified).status).toBe("FAIL");
  const proofSwap = structuredClone(report.evidence); [proofSwap[0]!.proof_sha256, proofSwap[1]!.proof_sha256] = [proofSwap[1]!.proof_sha256, proofSwap[0]!.proof_sha256];
  expect(inspectGithubLifecycleIndexBinding(result.targets, proofSwap).status).toBe("FAIL");
});
test("legacy lifecycle diagnostic cannot acquire credit through a valid current package", async () => {
  const f = nativeFixture(), result = await inspectGithubNativeArtifacts(f.get, f.download, SHA, f.text, "1.3.14", f.output);
  const report = indexedNativeReport(f.output, result.targets);
  expect(inspectGithubLifecycleIndexBinding(result.targets, report.evidence)).toEqual({ status: "UNVERIFIABLE", reason: "native-lifecycle-v2-required" });
});
test.each(["lifecycle-forged", "lifecycle-stale"])("fresh API metadata cannot authenticate %s lifecycle content", async mode => {
  const f = nativeFixture(mode);
  await expect(inspectGithubNativeArtifacts(f.get, f.download, SHA, f.text, "1.3.14", f.output)).rejects.toThrow();
});
test.each([...LIFECYCLE_PRODUCER_ENTRYPOINTS, ...LIFECYCLE_PRODUCER_DATA, "scripts/synthetic-lifecycle-leaf.ts"])("lifecycle producer custody binds %s", path => {
  const f = producerFixture(true), held = bindGithubLifecycleProducer(f.candidate.path, f.candidate.sha, f.reviewed.path, f.reviewed.sha);
  expect(held.candidate_files).toEqual(held.reviewed_files);
  writeFileSync(join(f.candidate.path, path), readFileSync(join(f.candidate.path, path), "utf8") + "\nchanged synthetic observation\n"); f.candidate.sha = f.commit(f.candidate.path);
  expect(() => bindGithubLifecycleProducer(f.candidate.path, f.candidate.sha, f.reviewed.path, f.reviewed.sha)).toThrow();
  expect(() => held.unchanged()).toThrow();
});

function p0IssueRow(id: number, number: number, extra: Record<string, unknown> = {}) {
  return {
    id, number, state: "open", title: `synthetic-title-${number}`, body: `synthetic-body-${number}`,
    user: { login: "synthetic-author" }, comments: 4, updated_at: "2026-09-07T00:00:00Z",
    labels: [{ id: 77, name: "severity:p0", color: "b60205", description: "must-not-retain" }],
    ...extra,
  };
}
function p0Git() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-github-p0-")); nativeRoots.push(root);
  const git = (args: string[]) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["-c", "init.defaultBranch=main", "init"]);
  writeFileSync(join(root, "README"), "main\n"); git(["add", "."]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "main"]);
  const mainSha = git(["rev-parse", "HEAD"]);
  writeFileSync(join(root, "README"), "candidate\n"); git(["add", "."]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "candidate"]);
  return { root, mainSha, candidateSha: git(["rev-parse", "HEAD"]) };
}
function p0Transport(git: ReturnType<typeof p0Git>, options: {
  issues?: any[]; finalIssues?: any[]; mainBefore?: string; mainAfter?: string;
  pageValue?: (endpoint: string, page: number, rows: any[]) => unknown;
} = {}) {
  const initial = options.issues ?? [], final = options.finalIssues ?? initial;
  let mainReads = 0, inventory = 0; const calls: string[] = [];
  const get = async (endpoint: string): Promise<any> => {
    calls.push(endpoint);
    const url = new URL(endpoint, "https://api.example.invalid");
    if (url.pathname === `/repositories/${GITHUB_REPOSITORY_ID}`) return { ...REPO };
    if (url.pathname === `/repos/${REPO.full_name}/git/ref/heads/main`) {
      const sha = ++mainReads === 1 ? (options.mainBefore ?? git.mainSha) : (options.mainAfter ?? options.mainBefore ?? git.mainSha);
      return { ref: "refs/heads/main", object: { type: "commit", sha } };
    }
    if (url.pathname === `/repos/${REPO.full_name}/issues`) {
      const page = Number(url.searchParams.get("page") ?? 1), rows = inventory === 0 ? initial : final;
      if (options.pageValue) {
        const value = options.pageValue(endpoint, page, rows);
        if (!Array.isArray(value) || value.length < 25) inventory = 1;
        return structuredClone(value);
      }
      const items = rows.slice((page - 1) * 25, page * 25);
      if (items.length < 25) inventory = 1;
      return structuredClone(items);
    }
    throw new Error("unexpected synthetic endpoint");
  };
  return { calls, get };
}
function p0Index(root: string, sha: string, receipts: { producer: string; gate_id: string; target: null; path: string; sha256: string }[] = []) {
  const index = join(root, "index.json");
  writeFileSync(index, JSON.stringify({ schema: "kizuki.acceptance-evidence/v4", candidate_source_sha: sha, artifacts: [], fixture_observation: null, gate_receipts: receipts }));
  return index;
}
function p0Gate(report: ReturnType<typeof evaluateRelease>) {
  return report.gates.find(row => row.id === "candidate.current-p0-disposition")!;
}

test("stable ancestor main and zero exact-label issues yield online P0 PASS; offline evaluateRelease stays UNVERIFIABLE", async () => {
  const git = p0Git(), transport = p0Transport(git);
  const observed = await inspectGithubCurrentP0(transport.get, git.candidateSha, git.root);
  expect(git.mainSha).not.toBe(git.candidateSha);
  expect(observed).toMatchObject({ candidate_source_sha: git.candidateSha, main_sha_before: git.mainSha, main_sha_after: git.mainSha, count: 0, inventory: [] });
  expect(inspectGithubP0Disposition(observed)).toEqual({ status: "PASS", reason: "github-current-p0-inventory-clear" });
  expect(transport.calls).toContain(`/repositories/${GITHUB_REPOSITORY_ID}`);
  expect(transport.calls).toContain(`/repos/${REPO.full_name}/git/ref/heads/main`);
  expect(transport.calls.filter(path => path.includes("/issues")).every(path => path.includes("labels=severity%3Ap0") && !path.includes("labels=severity:p0"))).toBe(true);
  expect(p0Gate(evaluateRelease("rc", p0Index(git.root, git.candidateSha)))).toMatchObject({
    status: "UNVERIFIABLE", reason: "trusted-snapshot-and-freshness-policy-unavailable", evidence_sha256: null,
  });
});

test("one valid open exact-label issue yields FAIL and retains no title or body", async () => {
  const git = p0Git(), issue = p0IssueRow(501, 12, { labels: [{ id: 1, name: "bug", color: "ffffff" }, { id: 2, name: "severity:p0", color: "b60205", description: "secret" }] });
  const observed = await inspectGithubCurrentP0(p0Transport(git, { issues: [issue] }).get, git.candidateSha, git.root);
  expect(inspectGithubP0Disposition(observed)).toEqual({ status: "FAIL", reason: "github-current-p0-findings-open" });
  expect(observed.inventory).toEqual([{ id: 501, number: 12, updated_at: "2026-09-07T00:00:00Z", labels: [{ name: "bug" }, { name: "severity:p0" }] }]);
  const retained = JSON.stringify(observed);
  expect(retained).not.toContain("synthetic-title-12");
  expect(retained).not.toContain("synthetic-body-12");
  expect(retained).not.toContain("synthetic-author");
  expect(retained).not.toContain("secret");
});

test("main that is not an ancestor or that changes before the final read is UNVERIFIABLE; a descendant candidate is valid", async () => {
  const git = p0Git();
  const descendant = await inspectGithubCurrentP0(p0Transport(git).get, git.candidateSha, git.root);
  expect(descendant.main_sha_before).toBe(git.mainSha);
  expect(descendant.main_sha_before).not.toBe(git.candidateSha);
  expect(inspectGithubP0Disposition(descendant).status).toBe("PASS");
  await expect(inspectGithubCurrentP0(p0Transport(git, { mainBefore: git.candidateSha }).get, git.mainSha, git.root)).rejects.toThrow("github-p0-main-not-ancestor");
  await expect(inspectGithubCurrentP0(p0Transport(git, { mainAfter: git.candidateSha }).get, git.candidateSha, git.root)).rejects.toThrow("github-p0-main-changed");
});

test.each([
  ["a PR-shaped row", [p0IssueRow(1, 1, { pull_request: { url: "https://example.invalid/pr" } })]],
  ["a missing label", [p0IssueRow(1, 1, { labels: [] })]],
  ["a wrong label", [p0IssueRow(1, 1, { labels: [{ name: "severity:p1" }] })]],
  ["a duplicate label", [p0IssueRow(1, 1, { labels: [{ name: "severity:p0" }, { name: "severity:p0" }] })]],
  ["a non-open state", [p0IssueRow(1, 1, { state: "closed" })]],
  ["a malformed id", [p0IssueRow(1, 1, { id: 0 })]],
  ["a malformed number", [p0IssueRow(1, 1, { number: "1" })]],
  ["a malformed timestamp", [p0IssueRow(1, 1, { updated_at: "2026-09-07T00:00:00.000Z" })]],
  ["a duplicate id", [p0IssueRow(1, 1), p0IssueRow(1, 2)]],
  ["a duplicate number", [p0IssueRow(1, 1), p0IssueRow(2, 1)]],
  ["a repository mismatch", [p0IssueRow(1, 1, { repository: { id: 1, full_name: "other/other" } })]],
  ["a repository URL mismatch", [p0IssueRow(1, 1, { repository_url: "https://api.github.com/repos/other/other" })]],
] as const)("%s refuses PASS", async (_name, issues) => {
  const git = p0Git();
  await expect(inspectGithubCurrentP0(p0Transport(git, { issues: [...issues] }).get, git.candidateSha, git.root)).rejects.toThrow(/github-p0-/);
});

test("a malformed array page and page-limit exhaustion refuse PASS", async () => {
  const git = p0Git();
  await expect(inspectGithubCurrentP0(p0Transport(git, { pageValue: () => ({ issues: [] }) }).get, git.candidateSha, git.root)).rejects.toThrow("github-p0-invalid-page");
  const overfull = Array.from({ length: 26 }, (_, i) => p0IssueRow(2000 + i, i + 1));
  await expect(inspectGithubCurrentP0(p0Transport(git, { issues: overfull, pageValue: (_endpoint, _page, rows) => rows.slice(0, 26) }).get, git.candidateSha, git.root)).rejects.toThrow("github-p0-invalid-page");
  const full = Array.from({ length: 500 }, (_, i) => p0IssueRow(3000 + i, i + 1));
  await expect(inspectGithubCurrentP0(p0Transport(git, { issues: full }).get, git.candidateSha, git.root)).rejects.toThrow("github-p0-inventory-limit");
});

test("two-page inventory succeeds only when complete; a changed final inventory refuses PASS", async () => {
  const git = p0Git();
  const issues = Array.from({ length: 26 }, (_, i) => p0IssueRow(4000 + i, 26 - i, { updated_at: "2026-09-07T00:00:00Z" }));
  const transport = p0Transport(git, { issues });
  const observed = await inspectGithubCurrentP0(transport.get, git.candidateSha, git.root);
  expect(observed.count).toBe(26);
  expect(observed.inventory.map(row => row.number)).toEqual(issues.map(row => row.number).sort((a, b) => a - b));
  expect(transport.calls.filter(path => path.endsWith("page=2"))).toHaveLength(2);
  expect(inspectGithubP0Disposition(observed).status).toBe("FAIL");
  const added = [...issues, p0IssueRow(5000, 99)];
  await expect(inspectGithubCurrentP0(p0Transport(git, { issues, finalIssues: added }).get, git.candidateSha, git.root)).rejects.toThrow("github-p0-inventory-changed");
  await expect(inspectGithubCurrentP0(p0Transport(git, { issues, finalIssues: issues.slice(1) }).get, git.candidateSha, git.root)).rejects.toThrow("github-p0-inventory-changed");
  const touched = issues.map((row, index) => index === 0 ? { ...row, updated_at: "2026-09-07T00:00:01Z" } : row);
  await expect(inspectGithubCurrentP0(p0Transport(git, { issues, finalIssues: touched }).get, git.candidateSha, git.root)).rejects.toThrow("github-p0-inventory-changed");
  const relabeled = issues.map((row, index) => index === 0 ? { ...row, labels: [{ name: "severity:p0" }, { name: "blocked" }] } : row);
  await expect(inspectGithubCurrentP0(p0Transport(git, { issues, finalIssues: relabeled }).get, git.candidateSha, git.root)).rejects.toThrow("github-p0-inventory-changed");
});

test("fixed 60s freshness and 5s skew cannot be relaxed by a fixture policy value", async () => {
  const git = p0Git(), completed = Date.now();
  const over = Object.assign(() => new Date((over as { n: number }).n++ === 0 ? completed - 60_001 : completed), { n: 0, max_ms: 120_000, observation_max_ms: 1_000_000, P0_OBSERVATION_MAX_MS: 120_000 });
  await expect(inspectGithubCurrentP0(p0Transport(git).get, git.candidateSha, git.root, over)).rejects.toThrow("github-p0-observation-stale");
  const inverted = Object.assign(() => new Date((inverted as { n: number }).n++ === 0 ? completed : completed - 1_000), { n: 0, max_ms: 120_000 });
  await expect(inspectGithubCurrentP0(p0Transport(git).get, git.candidateSha, git.root, inverted)).rejects.toThrow("github-p0-observation-time-order");
  const future = Object.assign(() => new Date(Date.now() + 10_000), { P0_CLOCK_SKEW_MS: 60_000, max_ms: 120_000 });
  await expect(inspectGithubCurrentP0(p0Transport(git).get, git.candidateSha, git.root, future)).rejects.toThrow("github-p0-observation-future");
});

test("a saved github-observation.json or handcrafted p0-disposition receipt cannot gain offline credit", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-github-p0-offline-")); nativeRoots.push(root);
  const observationPath = join(root, "github-observation.json");
  writeFileSync(observationPath, JSON.stringify({
    schema: "kizuki.github-collection/v1", candidate_source_sha: SHA, p0: { inventory: [], count: 0, failure: null },
    p0_failure: null, observation: { required: [] },
  }) + "\n");
  const receiptPath = join(root, "p0-disposition.json");
  writeFileSync(receiptPath, JSON.stringify({
    schema: "kizuki.p0-disposition/v1", gate_id: "candidate.current-p0-disposition", status: "PASS",
    live_p0_count: 0, reason: "github-current-p0-inventory-clear",
  }) + "\n");
  for (const path of [observationPath, receiptPath]) {
    const report = evaluateRelease("rc", p0Index(root, SHA, [{
      producer: "kizuki.p0-disposition/v1", gate_id: "candidate.current-p0-disposition", target: null, path, sha256: digest(readFileSync(path)),
    }]));
    expect(p0Gate(report)).toMatchObject({ status: "UNVERIFIABLE", reason: "trusted-snapshot-and-freshness-policy-unavailable", evidence_sha256: null });
    expect(report.decision).not.toBe("GO");
  }
});
