import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectProductSources } from "./release-evidence";
import { createHash } from "node:crypto";
import { writePackageFixture } from "./release-package-fixture";
import { CURRENT_PACKAGE_FILES } from "./release-artifacts";
import { artifactProofSteps, SQLITE_ENGINE_POLICY } from "./artifact-proof";
import { distributionIdentity } from "./release-notices";
import { verifyGithubNativeArchive } from "./github-native-artifact";
import { resolve } from "node:path";
import { GITHUB_REPOSITORY_ID, inspectGithubCandidate, inspectGithubNativeArtifacts, inspectGithubNativeJobs, validateGithubCommandBindings, bindGithubNativeProducer, parseGithubEvidenceArgs } from "./github-release-evidence";

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


const nativeRoots: string[] = [];
afterEach(() => { for (const root of nativeRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function syntheticArchive(target: string, mode = "valid") {
  const root = mkdtempSync(join(tmpdir(), "kizuki-github-native-")); nativeRoots.push(root);
  const directory = join(root, "package"); mkdirSync(directory);
  const build = writePackageFixture(directory, SHA, target);
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
  writeFileSync(join(root, "proof.json"), JSON.stringify(proof));
  const archive = join(root, "input.zip");
  execFileSync("python3", ["-c", `import pathlib,sys,zipfile,stat
root=pathlib.Path(sys.argv[1]); target=sys.argv[2]; mode=sys.argv[3]
items=[('repo/repo/dist/kizuki-0.1.0/'+target+'/'+p.name,p.read_bytes()) for p in (root/'package').iterdir()]
items += [('_temp/kizuki-native-artifact-proof/receipt.json',(root/'proof.json').read_bytes()),('_temp/kizuki-native-service-lifecycle/receipt.json',b'{"diagnostic":"synthetic only"}')]
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

function nativeFixture() {
  const f = fixture(), path = ".github/workflows/macos-native.yml", text = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
  const selected = f.run(301, path, 33); selected.event = "workflow_dispatch"; f.runs.splice(0, f.runs.length, selected);
  const steps = (Bun.YAML.parse(text) as any).jobs["native-service"].steps;
  const archives = new Map<number, ReturnType<typeof syntheticArchive>>();
  const artifacts: any[] = [];
  const jobs = ["ubuntu-24.04", "macos-15"].map((os, index) => {
    const archive = syntheticArchive(index === 0 ? "bun-linux-x64-baseline" : "bun-darwin-arm64"); archives.set(index + 401, archive);
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


function producerFixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-github-producer-")); nativeRoots.push(root);
  const source = resolve(import.meta.dir, "..");
  const graph = collectProductSources(source, ["scripts/stranger-proof.ts", "scripts/build-release.ts", "scripts/smoke-release.ts"]);
  const paths = [...new Set([...graph.bindings.map(file => file.path), ".bun-version", "bun.lock", "tsconfig.json"])];
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd: string) => { git(cwd, ["add", "-f", "."]); git(cwd, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "synthetic producer custody"]); return git(cwd, ["rev-parse", "HEAD"]); };
  const repos = ["reviewed", "candidate"].map(name => {
    const path = join(root, name); mkdirSync(path);
    for (const file of paths) { mkdirSync(dirname(join(path, file)), { recursive: true }); writeFileSync(join(path, file), readFileSync(join(source, file))); }
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
