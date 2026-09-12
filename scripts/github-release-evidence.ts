import { LIFECYCLE_PRODUCER_ENTRYPOINTS, LIFECYCLE_PRODUCER_DATA, LIFECYCLE_REGISTRY_SHA256, LIFECYCLE_HISTORY } from "./native-lifecycle-proof";
/** Explicit online GitHub observation. Saved JSON is never a trusted input. */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateRelease, releaseDecision, writeAcceptanceReport } from "./go-no-go";
import { absolute, assertCheckoutCustody, assertProductCheckoutCustody, digest, EVALUATOR_ROOT, EvidenceError, hash, parents, read, reject } from "./release-evidence";
import { parseProofJson } from "./proof-json";
import { validateToolchain, validateWorkflowText } from "./verify-workflows";
import { GITHUB_ARCHIVE_LIMIT, verifyGithubNativeArchive } from "./github-native-artifact";
import { CURRENT_PACKAGE_FILES } from "./release-artifacts";

export const GITHUB_REPOSITORY_ID = 1353875622;
interface GithubRepository { id: typeof GITHUB_REPOSITORY_ID; full_name: string; }
const PAGE_SIZE = 25;
const LIMITS = { json_bytes: 1_048_576, pages: 20, attempts: 10, jobs: 100, requests: 256, total_ms: 300_000, timeout_ms: 30_000 } as const;
const P0_LABEL = "severity:p0";
const P0_OBSERVATION_MAX_MS = 60_000;
const P0_CLOCK_SKEW_MS = 5_000;
const REQUIRED = [
  { path: ".github/workflows/ci.yml", jobs: ["test", "secrets"] },
  { path: ".github/workflows/workflows.yml", jobs: ["workflows"] },
] as const;
const CANDIDATE_FILES = [".bun-version", "package.json", "bun.lock", "tsconfig.json", ...REQUIRED.map(item => item.path), ".github/workflows/macos-native.yml"];
const COLLECTOR_FILES = [...CANDIDATE_FILES, "scripts/github-release-evidence.ts", "scripts/go-no-go.ts", "scripts/release-evidence.ts", "scripts/verify-workflows.ts", "scripts/proof-json.ts", "scripts/github-artifact-archive.py"];
type JsonObject = Record<string, unknown>;
type GetJson = (endpoint: string) => Promise<unknown>;
export interface GithubRun {
  id: number; run_number: number; run_attempt: number; workflow_id: number; path: string; head_sha: string;
  event: string; status: string; conclusion: string | null; created_at: string; updated_at: string; run_started_at: string;
}
export interface GithubJob {
  id: number; run_id: number; run_attempt: number; head_sha: string; name: string; status: string; conclusion: string | null;
  steps: { name: string; number: number; status: string; conclusion: string | null }[];
}
type Run = GithubRun;
type Job = GithubJob;
interface Requirement { path: string; jobs: readonly string[]; events?: readonly string[]; native?: boolean; }
export interface GithubCandidateObservation {
  schema: "kizuki.github-candidate-observation/v1"; repository: GithubRepository; candidate_source_sha: string;
  inventory: Run[]; attempts: { run_id: number; attempt: number; status: string; conclusion: string | null; path: string; run_started_at: string; created_at: string; updated_at: string }[];
  required: { path: string; run: Run | null; jobs: Job[]; status: "PASS" | "FAIL" | "MISSING"; reason: string }[];
}
interface GithubP0Issue { id: number; number: number; updated_at: string; labels: { name: string }[]; }
export interface GithubP0Observation {
  candidate_source_sha: string; main_sha_before: string; main_sha_after: string;
  inventory: GithubP0Issue[]; count: number; started_at: string; completed_at: string;
}

const PACKAGE_COMMANDS = ["verify", "typecheck", "build:release", "smoke:release", "proof:artifact"] as const;
export function validateGithubCommandBindings(candidate: Buffer, collector: Buffer) {
  const actual = object(object(parseProofJson(candidate)).scripts), reviewed = object(object(parseProofJson(collector)).scripts);
  return PACKAGE_COMMANDS.map(name => {
    const command = string(reviewed[name], 4096);
    if (actual[name] !== command) reject("github-candidate-command-mismatch");
    const hooks = ["pre", "post"].map(prefix => {
      const key = prefix + name, expected = reviewed[key] ?? null;
      if (expected !== null) string(expected, 4096);
      if ((actual[key] ?? null) !== expected) reject("github-candidate-command-mismatch");
      return expected;
    });
    return { name, command, pre: hooks[0], post: hooks[1] };
  });
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("github-invalid-schema");
  return value as JsonObject;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) reject("github-invalid-identity");
  return value;
}
function string(value: unknown, limit = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) reject("github-invalid-schema");
  return value;
}
function timestamp(value: unknown): string {
  const result = string(value, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result.replace("Z", ".000Z")) reject("github-invalid-timestamp");
  return result;
}
function status(value: unknown): string {
  const result = string(value, 32);
  if (!["completed", "queued", "in_progress", "waiting", "pending", "requested"].includes(result)) reject("github-invalid-status");
  return result;
}
function conclusion(value: unknown): string | null {
  if (value === null) return null;
  const result = string(value, 32);
  if (!["success", "failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"].includes(result)) reject("github-invalid-conclusion");
  return result;
}
function repository(value: unknown, expected: GithubRepository): void {
  const row = object(value);
  if (row.id !== expected.id || row.full_name !== expected.full_name) reject("github-repository-mismatch");
}
function run(value: unknown, candidate: string, expectedRepository: GithubRepository): Run {
  const row = object(value);
  repository(row.repository, expectedRepository); repository(row.head_repository, expectedRepository);
  if (row.head_sha !== candidate || object(row.head_commit).id !== candidate) reject("github-candidate-mismatch");
  return { id: integer(row.id), run_number: integer(row.run_number), run_attempt: integer(row.run_attempt), workflow_id: integer(row.workflow_id),
    path: string(row.path), head_sha: candidate, event: string(row.event, 32), status: status(row.status), conclusion: conclusion(row.conclusion),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at), run_started_at: timestamp(row.run_started_at) };
}
function job(value: unknown, expected: Run): Job {
  const row = object(value);
  if (row.run_id !== expected.id || row.run_attempt !== expected.run_attempt || row.head_sha !== expected.head_sha) reject("github-job-identity-mismatch");
  if (!Array.isArray(row.steps) || row.steps.length > 100) reject("github-invalid-steps");
  const steps = row.steps.map(value => {
    const step = object(value);
    return { name: string(step.name), number: integer(step.number), status: status(step.status), conclusion: conclusion(step.conclusion) };
  });
  if (new Set(steps.map(step => step.number)).size !== steps.length) reject("github-duplicate-step");
  return { id: integer(row.id), run_id: expected.id, run_attempt: expected.run_attempt, head_sha: expected.head_sha,
    name: string(row.name), status: status(row.status), conclusion: conclusion(row.conclusion), steps };
}
async function pages(get: GetJson, path: string, field: string, limit: number): Promise<unknown[]> {
  const rows: unknown[] = []; let total: number | undefined;
  for (let page = 1; page <= LIMITS.pages; page++) {
    const value = object(await get(`${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`));
    if (!Number.isSafeInteger(value.total_count) || (value.total_count as number) < 0 || (value.total_count as number) > limit) reject("github-inventory-limit");
    if (total !== undefined && total !== value.total_count) reject("github-inventory-changed");
    total = value.total_count as number;
    const items = value[field];
    if (!Array.isArray(items) || items.length > PAGE_SIZE) reject("github-invalid-page");
    rows.push(...items);
    if (rows.length > total || (items.length === 0 && rows.length !== total)) reject("github-incomplete-inventory");
    if (rows.length === total) return rows;
    if (items.length !== PAGE_SIZE) reject("github-incomplete-inventory");
  }
  reject("github-inventory-limit");
}
async function inventory(get: GetJson, candidate: string, expectedRepository: GithubRepository): Promise<Run[]> {
  const result = (await pages(get, `/repos/${expectedRepository.full_name}/actions/runs?head_sha=${candidate}`, "workflow_runs", PAGE_SIZE * LIMITS.pages)).map(row => run(row, candidate, expectedRepository));
  if (new Set(result.map(row => row.id)).size !== result.length) reject("github-duplicate-run");
  return result.sort((a, b) => a.id - b.id);
}
function latestAttempt(rows: Run[]): Run | null {
  if (new Set(rows.map(row => row.run_number)).size !== rows.length || new Set(rows.map(row => row.workflow_id)).size > 1) reject("github-workflow-identity-mismatch");
  const ordered = [...rows].sort((a, b) => Date.parse(b.run_started_at) - Date.parse(a.run_started_at));
  if (ordered.length > 1 && ordered[0]!.run_started_at === ordered[1]!.run_started_at) reject("github-attempt-order-ambiguous");
  return ordered[0] ?? null;
}
// GitHub run and attempt resources have distinct creation/update timestamps.
// Compare identity, start and outcome across resources; freshness rereads each
// endpoint's complete projection, including its own creation/update timestamps.
function sameLatestAttempt(observed: Run, current: Run): boolean {
  const { created_at: _attemptCreated, updated_at: _attemptUpdated, ...attempt } = observed;
  const { created_at: _runCreated, updated_at: _runUpdated, ...run } = current;
  return same(attempt, run);
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

/** Evidence analysis is testable, but its result is untrusted until the private
 * online entrypoint obtains it from the fixed GitHub transport and binds source. */
export async function inspectGithubCandidate(transport: GetJson, candidate: string, workflows: ReadonlyMap<string, string>): Promise<GithubCandidateObservation> {
  return inspectGithubWorkflows(transport, candidate, workflows, REQUIRED);
}

async function inspectGithubWorkflows(transport: GetJson, candidate: string, workflows: ReadonlyMap<string, string>, requirements: readonly Requirement[]): Promise<GithubCandidateObservation> {
  digest(candidate, 40);
  let requests = 0; const started = performance.now();
  const get: GetJson = async endpoint => {
    if (++requests > LIMITS.requests || performance.now() - started > LIMITS.total_ms) reject("github-observation-limit");
    return transport(endpoint);
  };
  const repo = object(await get(`/repositories/${GITHUB_REPOSITORY_ID}`));
  if (repo.id !== GITHUB_REPOSITORY_ID || repo.private !== false || typeof repo.full_name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo.full_name)) reject("github-repository-mismatch");
  const expectedRepository: GithubRepository = { id: GITHUB_REPOSITORY_ID, full_name: repo.full_name };
  const prefix = `/repos/${repo.full_name}`;
  const before = await inventory(get, candidate, expectedRepository);
  const attempts: GithubCandidateObservation["attempts"] = [];
  const required: GithubCandidateObservation["required"] = [];
  const latestAttempts: Run[] = [];
  for (const requirement of requirements) {
    const histories = before.filter(row => row.path === requirement.path);
    const workflowAttempts: Run[] = [];
    // Every bounded attempt is retained. An old run's fresh rerun can supersede
    // a newer run number, and any still-pending attempt prevents gate credit.
    let pending = false;
    for (const historical of histories) {
      if (!(requirement.events ?? ["push", "pull_request"]).includes(historical.event)) reject("github-workflow-event-mismatch");
      if (historical.run_attempt > LIMITS.attempts) reject("github-attempt-limit");
      const current = run(await get(`${prefix}/actions/runs/${historical.id}`), candidate, expectedRepository);
      if (!same(current, historical)) reject("github-run-changed");
      let previousStart: string | null = null;
      for (let attempt = 1; attempt <= historical.run_attempt; attempt++) {
        const observed = run(await get(`${prefix}/actions/runs/${historical.id}/attempts/${attempt}`), candidate, expectedRepository);
        if (observed.id !== historical.id || observed.run_number !== historical.run_number || observed.workflow_id !== historical.workflow_id || observed.path !== historical.path || observed.event !== historical.event || observed.run_attempt !== attempt) reject("github-attempt-identity-mismatch");
        if (previousStart !== null && Date.parse(previousStart) >= Date.parse(observed.run_started_at)) reject("github-attempt-order-ambiguous");
        previousStart = observed.run_started_at;
        pending ||= observed.status !== "completed";
        attempts.push({ run_id: observed.id, attempt, path: observed.path, status: observed.status, conclusion: observed.conclusion,
          run_started_at: observed.run_started_at, created_at: observed.created_at, updated_at: observed.updated_at });
        if (attempt === current.run_attempt) {
          if (!sameLatestAttempt(observed, current)) reject("github-attempt-changed");
          workflowAttempts.push(observed); latestAttempts.push(observed);
        }
      }
    }
    const current = latestAttempt(workflowAttempts);
    if (current === null) {
      required.push({ path: requirement.path, run: null, jobs: [], status: "MISSING", reason: "github-required-workflow-missing" }); continue;
    }
    if (pending) {
      required.push({ path: requirement.path, run: current, jobs: [], status: "FAIL", reason: "github-required-attempt-pending" }); continue;
    }
    const jobs = (await pages(get, `${prefix}/actions/runs/${current.id}/attempts/${current.run_attempt}/jobs`, "jobs", LIMITS.jobs)).map(row => job(row, current));
    if (new Set(jobs.map(row => row.id)).size !== jobs.length || new Set(jobs.map(row => row.name)).size !== jobs.length) reject("github-duplicate-job");
    const workflowText = workflows.get(requirement.path);
    if (workflowText === undefined || validateWorkflowText(requirement.path, workflowText).length > 0) reject("github-candidate-workflow-invalid");
    const configured = object(object(Bun.YAML.parse(workflowText)).jobs);
    let ok = current.status === "completed" && current.conclusion === "success";
    if (jobs.length !== requirement.jobs.length + (requirement.native ? 1 : 0)) ok = false;
    if (requirement.native) {
      const inactive = jobs.find(row => row.name === "native-arm64");
      if (!inactive || inactive.status !== "completed" || inactive.conclusion !== "skipped" || inactive.steps.length !== 0) ok = false;
    }
    for (const name of requirement.jobs) {
      const actual = jobs.find(item => item.name === name);
      const definition = object(configured[requirement.native ? "native-service" : name]);
      if (!actual || actual.status !== "completed" || actual.conclusion !== "success") { ok = false; continue; }
      if (!Array.isArray(definition.steps)) reject("github-candidate-workflow-invalid");
      for (let index = 0; index < definition.steps.length; index++) {
        const step = object(definition.steps[index]);
        const expectedName = step.name ?? (typeof step.uses === "string" ? `Run ${step.uses}` : null);
        if (typeof expectedName !== "string") reject("github-unbound-step-name");
        const observed = actual.steps.find(item => item.number === index + 2);
        const expectedConclusion = requirement.native && name === "native-service (macos-15)" && step.if === "${{ runner.os == 'Linux' }}" ? "skipped" : "success";
        if (!observed || observed.name !== expectedName || observed.status !== "completed" || observed.conclusion !== expectedConclusion) ok = false;
      }
    }
    required.push({ path: requirement.path, run: current, jobs, status: ok ? "PASS" : "FAIL", reason: ok ? "github-current-required-jobs-passed" : "github-current-required-jobs-not-passed" });
  }
  const after = await inventory(get, candidate, expectedRepository);
  if (!same(before, after)) reject("github-inventory-changed");
  for (const latest of latestAttempts) {
    const original = before.find(row => row.id === latest.id)!;
    if (!same(original, run(await get(`${prefix}/actions/runs/${latest.id}`), candidate, expectedRepository))) reject("github-run-changed");
    if (!same(latest, run(await get(`${prefix}/actions/runs/${latest.id}/attempts/${latest.run_attempt}`), candidate, expectedRepository))) reject("github-attempt-changed");
  }
  return { schema: "kizuki.github-candidate-observation/v1", repository: expectedRepository, candidate_source_sha: candidate, inventory: before, attempts, required };
}

export async function inspectGithubNativeJobs(transport: GetJson, candidate: string, workflow: string): Promise<GithubCandidateObservation> {
  return inspectGithubWorkflows(transport, candidate, new Map([[".github/workflows/macos-native.yml", workflow]]), [{
    path: ".github/workflows/macos-native.yml", jobs: ["native-service (ubuntu-24.04)", "native-service (macos-15)"], events: ["workflow_dispatch"], native: true,
  }]);
}

const NATIVE_PRODUCER_ENTRYPOINTS = ["scripts/stranger-proof.ts", "scripts/build-release.ts", "scripts/smoke-release.ts"] as const;
/** Evidence harness code is reviewed separately from the product it executes. */
export function bindGithubNativeProducer(candidateRoot: string, candidateSha: string, collectorRoot: string, collectorSha: string) {
  return bindProducer(candidateRoot, candidateSha, collectorRoot, collectorSha, NATIVE_PRODUCER_ENTRYPOINTS, [], "github-native-producer-unreviewed");
}
/** Separate lifecycle source custody: string-addressed children and SQL/JSON inputs
 * are explicit roots in addition to actual compiler-resolved transitive imports. */
export function bindGithubLifecycleProducer(candidateRoot: string, candidateSha: string, collectorRoot: string, collectorSha: string) {
  const frame = bindProducer(candidateRoot, candidateSha, collectorRoot, collectorSha, [...LIFECYCLE_PRODUCER_ENTRYPOINTS, ...NATIVE_PRODUCER_ENTRYPOINTS], LIFECYCLE_PRODUCER_DATA, "github-lifecycle-producer-unreviewed");
  if (LIFECYCLE_HISTORY.some(input => frame.candidate_files.find(file => file.path === `packages/core/test/fixtures/${input.file}`)?.sha256 !== input.sha256)) reject("github-lifecycle-historical-input-mismatch");
  return frame;
}
function bindProducer(candidateRoot: string, candidateSha: string, collectorRoot: string, collectorSha: string, entrypoints: readonly string[], data: readonly string[], reason: string) {
  const metadata = [".bun-version", "bun.lock", "tsconfig.json", ...data];
  const reviewed = assertProductCheckoutCustody(collectorRoot, collectorSha, entrypoints, metadata);
  const candidate = assertProductCheckoutCustody(candidateRoot, candidateSha, entrypoints, metadata);
  const projection = (frame: typeof candidate) => frame.files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  const candidate_files = projection(candidate), reviewed_files = projection(reviewed);
  if (!same(candidate_files, reviewed_files)) reject(reason);
  return { candidate_files, reviewed_files, unchanged: () => { candidate.unchanged(); reviewed.unchanged(); } };
}

const NATIVE_TARGETS = [
  { os: "ubuntu-24.04", target: "bun-linux-x64-baseline" },
  { os: "macos-15", target: "bun-darwin-arm64" },
] as const;
interface Artifact {
  id: number; name: string; size_in_bytes: number; digest: string; created_at: string; updated_at: string; expires_at: string;
}
function artifact(value: unknown, selected: Run, repo: GithubRepository): Artifact {
  const row = object(value), owner = object(row.workflow_run);
  if (owner.id !== selected.id || owner.repository_id !== repo.id || owner.head_repository_id !== repo.id || owner.head_sha !== selected.head_sha) reject("github-artifact-identity-mismatch");
  if (row.expired !== false || integer(row.size_in_bytes) > GITHUB_ARCHIVE_LIMIT || typeof row.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.digest)) reject("github-artifact-unavailable");
  return { id: integer(row.id), name: string(row.name), size_in_bytes: integer(row.size_in_bytes), digest: row.digest,
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at), expires_at: timestamp(row.expires_at) };
}
function nativeJob(value: unknown, selected: Run, expected: Job, os: string) {
  const row = object(value);
  if (!same(job(row, selected), expected) || !same(row.labels, [os]) || row.runner_group_id !== 0 || row.runner_group_name !== "GitHub Actions") reject("github-native-job-mismatch");
  const started_at = timestamp(row.started_at), completed_at = timestamp(row.completed_at);
  const steps = (row.steps as unknown[]).map(object);
  const upload = steps.find(step => step.name === "retain lifecycle receipt even when a native gate fails");
  if (!upload || upload.conclusion !== "success") reject("github-native-upload-missing");
  const upload_started_at = timestamp(upload.started_at), upload_completed_at = timestamp(upload.completed_at);
  if (Date.parse(started_at) < Date.parse(selected.run_started_at) || Date.parse(completed_at) < Date.parse(started_at) ||
      Date.parse(upload_started_at) < Date.parse(started_at) || Date.parse(upload_completed_at) < Date.parse(upload_started_at) ||
      Date.parse(upload_completed_at) > Date.parse(completed_at)) reject("github-native-job-time-mismatch");
  return { job_id: expected.id, runner_id: integer(row.runner_id), labels: [os], runner_group_id: 0, started_at, completed_at, upload_started_at, upload_completed_at };
}

/** Synthetic API analysis has no gate authority. Only the private fixed online
 * transport's result can be applied inside evaluateReleaseOnline. */
export async function inspectGithubNativeArtifacts(get: GetJson, download: (endpoint: string) => Promise<Buffer>, candidate: string, workflow: string, bunVersion: string, output: string) {
  const observation = await inspectGithubNativeJobs(get, candidate, workflow);
  const current = observation.required[0]!;
  const targets: { target: string; artifact: Artifact; job: ReturnType<typeof nativeJob>; bytes: ReturnType<typeof verifyGithubNativeArchive> }[] = [];
  if (current.status !== "PASS" || current.run === null) return { observation, status: "FAIL" as const, targets };
  const selected = current.run, prefix = `/repos/${observation.repository.full_name}`;
  const rawJobs = await pages(get, `${prefix}/actions/runs/${selected.id}/attempts/${selected.run_attempt}/jobs`, "jobs", LIMITS.jobs);
  const collectArtifacts = async () => (await pages(get, `${prefix}/actions/runs/${selected.id}/artifacts`, "artifacts", 100))
    .map(row => artifact(row, selected, observation.repository)).sort((a, b) => a.id - b.id);
  const artifacts = await collectArtifacts();
  if (artifacts.length !== 2 || new Set(artifacts.map(row => row.id)).size !== 2 || new Set(artifacts.map(row => row.name)).size !== 2) reject("github-native-artifact-inventory");
  for (const target of NATIVE_TARGETS) {
    const expectedJob = current.jobs.find(row => row.name === `native-service (${target.os})`)!;
    const raw = rawJobs.filter(value => object(value).id === expectedJob.id);
    if (raw.length !== 1) reject("github-native-job-mismatch");
    const host = nativeJob(raw[0], selected, expectedJob, target.os);
    const retained = artifacts.find(row => row.name === `native-service-lifecycle-${target.os}-${candidate}`);
    if (!retained || Date.parse(retained.created_at) < Date.parse(host.upload_started_at) || Date.parse(retained.created_at) > Date.parse(host.upload_completed_at) ||
        Date.parse(retained.updated_at) > Date.parse(host.upload_completed_at) || Date.parse(retained.updated_at) < Date.parse(retained.created_at)) reject("github-artifact-attempt-unbound");
    const body = await download(`${prefix}/actions/artifacts/${retained.id}/zip`);
    if (body.length !== retained.size_in_bytes || `sha256:${hash(body)}` !== retained.digest) reject("github-artifact-digest-mismatch");
    const archive = join(output, `${target.target}.zip`);
    writeFileSync(archive, body, { flag: "wx", mode: 0o600 });
    const bytes = verifyGithubNativeArchive(archive, join(output, target.target), target.target, candidate, bunVersion);
    if (bytes.lifecycle.facts?.observed_model_starts.some(start => Date.parse(start) < Date.parse(host.started_at) || Date.parse(start) > Date.parse(host.upload_started_at))) reject("github-lifecycle-time-unbound");
    targets.push({ target: target.target, artifact: retained, job: host, bytes });
    if (!same(retained, artifact(await get(`${prefix}/actions/artifacts/${retained.id}`), selected, observation.repository))) reject("github-artifact-changed");
  }
  if (!same(artifacts, await collectArtifacts())) reject("github-artifact-changed");
  const finalJobs = await pages(get, `${prefix}/actions/runs/${selected.id}/attempts/${selected.run_attempt}/jobs`, "jobs", LIMITS.jobs);
  for (const target of NATIVE_TARGETS) {
    const expectedJob = current.jobs.find(row => row.name === `native-service (${target.os})`)!;
    const raw = finalJobs.filter(value => object(value).id === expectedJob.id);
    if (raw.length !== 1 || !same(targets.find(row => row.target === target.target)!.job, nativeJob(raw[0], selected, expectedJob, target.os))) reject("github-native-job-changed");
  }
  if (!same(observation, await inspectGithubNativeJobs(get, candidate, workflow))) reject("github-native-attempt-changed");
  return { observation, status: "PASS" as const, targets };
}

/** Digest comparison only, with no gate authority. Only the private online
 * evaluation supplies verified inputs and can apply this result to gates. */
export function inspectGithubNativeIndexBinding(
  targets: Awaited<ReturnType<typeof inspectGithubNativeArtifacts>>["targets"],
  evidence: ReturnType<typeof evaluateRelease>["evidence"],
): { status: "PASS" | "FAIL" | "UNVERIFIABLE"; reason: string } {
  if (targets.length !== NATIVE_TARGETS.length || NATIVE_TARGETS.some(expected => targets.filter(row => row.target === expected.target).length !== 1))
    return { status: "FAIL", reason: "github-native-index-target-mismatch" };
  let missing = false;
  for (const target of targets) {
    const indexed = evidence.filter(row => row.target === target.target);
    if (indexed.length === 0) { missing = true; continue; }
    const row = indexed[0]!;
    if (indexed.length !== 1 || row.producer !== "kizuki.artifact-proof/v3" || target.bytes.target !== target.target || target.bytes.build.target !== target.target ||
        row.proof_sha256 !== target.bytes.proof_sha256 || Object.keys(row.package_sha256).length !== CURRENT_PACKAGE_FILES.length ||
        CURRENT_PACKAGE_FILES.some(name => row.package_sha256[name] !== target.bytes.package_sha256[name]))
      return { status: "FAIL", reason: "github-native-index-package-mismatch" };
  }
  return missing ? { status: "UNVERIFIABLE", reason: "github-native-package-not-indexed" }
    : { status: "PASS", reason: "github-paired-native-package-proof" };
}

/** Pure comparison, not authority. Only the fixed online transport can apply it. */
export function inspectGithubLifecycleIndexBinding(targets: Awaited<ReturnType<typeof inspectGithubNativeArtifacts>>["targets"], evidence: ReturnType<typeof evaluateRelease>["evidence"]) {
  const packages = inspectGithubNativeIndexBinding(targets, evidence);
  if (packages.status !== "PASS") return packages;
  if (targets.some(target => target.bytes.lifecycle.facts === null)) return { status: "UNVERIFIABLE" as const, reason: "native-lifecycle-v2-required" };
  if (targets.some(target => target.bytes.lifecycle.facts!.source_sha !== target.bytes.build.source_sha || target.bytes.lifecycle.facts!.target !== target.target || target.bytes.lifecycle.facts!.registry_sha256 !== LIFECYCLE_REGISTRY_SHA256)) return { status: "FAIL" as const, reason: "github-lifecycle-package-mismatch" };
  return { status: "PASS" as const, reason: "github-current-native-candidate-lifecycle" };
}

async function arrayPages(get: GetJson, path: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 1; page <= LIMITS.pages; page++) {
    const value = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(value) || value.length > PAGE_SIZE) reject("github-p0-invalid-page");
    if (rows.length + value.length > PAGE_SIZE * LIMITS.pages) reject("github-p0-inventory-limit");
    rows.push(...value);
    if (value.length !== PAGE_SIZE) return rows;
  }
  reject("github-p0-inventory-limit");
}
function p0Issue(value: unknown, expectedRepository: GithubRepository): GithubP0Issue {
  const row = object(value);
  if ("pull_request" in row) reject("github-p0-pull-request");
  if (row.state !== "open") reject("github-p0-not-open");
  if (row.repository !== undefined) repository(row.repository, expectedRepository);
  if (row.repository_url !== undefined &&
      string(row.repository_url, 512) !== `https://api.github.com/repos/${expectedRepository.full_name}`) reject("github-p0-repository-mismatch");
  const id = integer(row.id), number = integer(row.number), updated_at = timestamp(row.updated_at);
  if (!Array.isArray(row.labels) || row.labels.length > 32) reject("github-p0-invalid-schema");
  const labels = row.labels.map(item => ({ name: string(object(item).name, 64) }));
  if (new Set(labels.map(label => label.name)).size !== labels.length) reject("github-p0-duplicate-label");
  if (!labels.some(label => label.name === P0_LABEL)) reject("github-p0-label-mismatch");
  return { id, number, updated_at, labels };
}
function p0Inventory(rows: unknown[], expectedRepository: GithubRepository): GithubP0Issue[] {
  const issues = rows.map(row => p0Issue(row, expectedRepository));
  if (new Set(issues.map(row => row.id)).size !== issues.length || new Set(issues.map(row => row.number)).size !== issues.length)
    reject("github-p0-duplicate-issue");
  return issues.sort((a, b) => a.number - b.number);
}
function mainCommit(value: unknown): string {
  const row = object(value);
  if (row.ref !== "refs/heads/main") reject("github-p0-main-ref-invalid");
  const target = object(row.object);
  if (target.type !== "commit") reject("github-p0-main-ref-invalid");
  return digest(target.sha, 40);
}
function assertMainAncestor(root: string, mainSha: string, candidateSha: string) {
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", mainSha, candidateSha],
      { encoding: "utf8", timeout: LIMITS.timeout_ms, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    reject("github-p0-main-not-ancestor");
  }
}
function publicP0Repository(value: unknown): GithubRepository {
  const repo = object(value);
  if (repo.id !== GITHUB_REPOSITORY_ID || repo.private !== false || typeof repo.full_name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo.full_name)) reject("github-p0-repository-mismatch");
  return { id: GITHUB_REPOSITORY_ID, full_name: repo.full_name };
}
function rethrowP0(error: unknown): never {
  if (error instanceof EvidenceError) {
    if (error.reason.startsWith("github-p0-")) throw error;
    if (error.reason.startsWith("github-")) reject(`github-p0-${error.reason.slice(7)}`);
    if (error.reason === "invalid-digest") reject("github-p0-invalid-identity");
  }
  reject("github-p0-observation-unavailable");
}

/** Synthetic P0 analysis has no gate authority. Only evaluateReleaseOnline
 * overlays candidate.current-p0-disposition from a live fixed-transport collection. */
export async function inspectGithubCurrentP0(transport: GetJson, candidate: string, candidateRoot: string, now: () => Date = () => new Date()): Promise<GithubP0Observation> {
  try {
    digest(candidate, 40);
    let requests = 0; const window = performance.now();
    const get: GetJson = async endpoint => {
      if (++requests > LIMITS.requests || performance.now() - window > LIMITS.total_ms) reject("github-p0-observation-limit");
      return transport(endpoint);
    };
    const startedAt = now();
    const expectedRepository = publicP0Repository(await get(`/repositories/${GITHUB_REPOSITORY_ID}`));
    const prefix = `/repos/${expectedRepository.full_name}`;
    const mainBefore = mainCommit(await get(`${prefix}/git/ref/heads/main`));
    assertMainAncestor(candidateRoot, mainBefore, candidate);
    const issuesPath = `${prefix}/issues?state=open&labels=severity%3Ap0`;
    const initial = p0Inventory(await arrayPages(get, issuesPath), expectedRepository);
    const finalInventory = p0Inventory(await arrayPages(get, issuesPath), expectedRepository);
    if (!same(initial, finalInventory)) reject("github-p0-inventory-changed");
    const mainAfter = mainCommit(await get(`${prefix}/git/ref/heads/main`));
    if (mainAfter !== mainBefore) reject("github-p0-main-changed");
    const completedAt = now();
    const startedMs = startedAt.getTime(), completedMs = completedAt.getTime();
    if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) reject("github-p0-invalid-timestamp");
    if (completedMs < startedMs) reject("github-p0-observation-time-order");
    if (completedMs - startedMs > P0_OBSERVATION_MAX_MS) reject("github-p0-observation-stale");
    if (completedMs - Date.now() > P0_CLOCK_SKEW_MS) reject("github-p0-observation-future");
    return {
      candidate_source_sha: candidate, main_sha_before: mainBefore, main_sha_after: mainAfter,
      inventory: initial, count: initial.length, started_at: startedAt.toISOString(), completed_at: completedAt.toISOString(),
    };
  } catch (error) { rethrowP0(error); }
}

/** Pure mapping, not authority. Only evaluateReleaseOnline may overlay the gate. */
export function inspectGithubP0Disposition(observation: GithubP0Observation): { status: "PASS" | "FAIL"; reason: string } {
  return observation.count === 0 && observation.inventory.length === 0
    ? { status: "PASS", reason: "github-current-p0-inventory-clear" }
    : { status: "FAIL", reason: "github-current-p0-findings-open" };
}

function allowedGithubEndpoint(endpoint: string): boolean {
  if (!/^[/A-Za-z0-9_.?=&%-]+$/.test(endpoint)) return false;
  if (endpoint === `/repositories/${GITHUB_REPOSITORY_ID}`) return true;
  const names = "^/repos/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}";
  if (new RegExp(`${names}/actions/`).test(endpoint)) return true;
  if (new RegExp(`${names}/git/ref/heads/main$`).test(endpoint)) return true;
  const issues = endpoint.match(new RegExp(`${names}/issues\\?state=open&labels=severity%3Ap0&per_page=${PAGE_SIZE}&page=([1-9][0-9]*)$`));
  if (!issues) return false;
  const page = Number(issues[1]);
  return Number.isSafeInteger(page) && page >= 1 && page <= LIMITS.pages;
}

function ghJson(endpoint: string, binary = false): Buffer {
  if (!allowedGithubEndpoint(endpoint)) reject("github-endpoint-refused");
  try {
    return execFileSync("gh", ["api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", endpoint],
      { maxBuffer: binary ? GITHUB_ARCHIVE_LIMIT : LIMITS.json_bytes, timeout: LIMITS.timeout_ms, stdio: ["ignore", "pipe", "pipe"] });
  } catch { reject("github-read-unavailable"); }
}

export async function evaluateReleaseOnline(profile: "rc" | "1.0", evidence: string, candidateRoot: string, output: string) {
  absolute(output); absolute(candidateRoot);
  const index = read(evidence, 32768);
  let report = evaluateRelease(profile, evidence);
  if (report.candidate_source_sha === null || report.gates.find(row => row.id === "evidence.index")?.status !== "PASS") reject("github-index-invalid");
  const candidate = report.candidate_source_sha;
  const root = realpathSync(candidateRoot);
  if (root !== candidateRoot) reject("github-candidate-root-alias");
  const candidateFrame = assertCheckoutCustody(root, candidate, CANDIDATE_FILES);
  const collectorHead = execFileSync("git", ["-C", EVALUATOR_ROOT, "rev-parse", "HEAD"], { encoding: "utf8", timeout: LIMITS.timeout_ms }).trim();
  const collectorFrame = assertProductCheckoutCustody(EVALUATOR_ROOT, collectorHead, ["scripts/github-release-evidence.ts"], COLLECTOR_FILES);
  if (validateToolchain(root).length > 0) reject("github-candidate-toolchain-invalid");
  const commandBindings = validateGithubCommandBindings(candidateFrame.files.find(file => file.path === "package.json")!.bytes,
    collectorFrame.files.find(file => file.path === "package.json")!.bytes);
  const workflows = new Map(REQUIRED.map(item => [item.path, candidateFrame.files.find(file => file.path === item.path)!.bytes.toString("utf8")]));
  const checkOutputParent = parents(output);
  mkdirSync(output, { mode: 0o700 }); checkOutputParent();
  const checkOutput = parents(join(output, "github-observation.json"));
  const raw: { path: string; endpoint: string; sha256: string; bytes: number }[] = [];
  const started = new Date().toISOString();
  let observation: GithubCandidateObservation | null = null;
  let failure: string | null = null;
  let native: Awaited<ReturnType<typeof inspectGithubNativeArtifacts>> | null = null;
  let nativeFailure: string | null = null;
  let nativeProducer: ReturnType<typeof bindGithubNativeProducer> | null = null;
  let lifecycleProducer: ReturnType<typeof bindGithubLifecycleProducer> | null = null;
  let lifecycleFailure: string | null = null;
  let p0: GithubP0Observation | null = null;
  let p0Failure: string | null = null;
  let onlineRequests = 0; const onlineStarted = performance.now();
  const bounded = () => { if (++onlineRequests > LIMITS.requests || performance.now() - onlineStarted > LIMITS.total_ms) reject("github-observation-limit"); };
  const get: GetJson = async endpoint => {
      bounded();
      const bytes = ghJson(endpoint), name = `github-${String(raw.length + 1).padStart(4, "0")}.json`;
      writeFileSync(join(output, name), bytes, { flag: "wx", mode: 0o600 });
      raw.push({ path: name, endpoint, sha256: hash(bytes), bytes: bytes.length });
      return parseProofJson(bytes);
  };
  try {
    observation = await inspectGithubCandidate(get, candidate, workflows);
    try {
      nativeProducer = bindGithubNativeProducer(root, candidate, EVALUATOR_ROOT, collectorHead);
      try { lifecycleProducer = bindGithubLifecycleProducer(root, candidate, EVALUATOR_ROOT, collectorHead); }
      catch (error) { lifecycleFailure = error instanceof EvidenceError ? error.reason : "github-lifecycle-producer-unavailable"; }
      const nativeWorkflow = candidateFrame.files.find(file => file.path === ".github/workflows/macos-native.yml")!.bytes.toString("utf8");
      const bunVersion = candidateFrame.files.find(file => file.path === ".bun-version")!.bytes.toString("utf8").trim();
      native = await inspectGithubNativeArtifacts(get, async endpoint => { bounded(); return ghJson(endpoint, true); }, candidate, nativeWorkflow, bunVersion, output);
    } catch (error) { nativeFailure = error instanceof EvidenceError ? error.reason : "github-native-observation-unavailable"; }
    // Native downloads may take time: CI credit must still describe current facts.
    if (!same(observation, await inspectGithubCandidate(get, candidate, workflows))) reject("github-required-checks-changed");
    try { p0 = await inspectGithubCurrentP0(get, candidate, root); }
    catch (error) {
      p0Failure = error instanceof EvidenceError && error.reason.startsWith("github-p0-") ? error.reason : "github-p0-observation-unavailable";
    }
    candidateFrame.unchanged(); collectorFrame.unchanged(); nativeProducer?.unchanged(); lifecycleProducer?.unchanged(); index.unchanged(); checkOutput();
  } catch (error) { failure = error instanceof EvidenceError ? error.reason : "github-observation-unavailable"; }
  const retained = { schema: "kizuki.github-collection/v1", candidate_source_sha: candidate, collector_source_sha: collectorHead,
    candidate_files: candidateFrame.files.map(({ path, sha256 }) => ({ path, sha256 })), collector_files: collectorFrame.files.map(({ path, sha256 }) => ({ path, sha256 })),
    started_at: started, completed_at: new Date().toISOString(), command_bindings: commandBindings, raw, observation, failure, native, native_failure: nativeFailure,
    lifecycle_failure: lifecycleFailure,
    lifecycle_producer: lifecycleProducer === null ? null : { candidate_files: lifecycleProducer.candidate_files, reviewed_files: lifecycleProducer.reviewed_files },
    native_producer: nativeProducer === null ? null : { candidate_files: nativeProducer.candidate_files, reviewed_files: nativeProducer.reviewed_files },
    p0, p0_failure: p0Failure,
    trust_scope: "fresh GitHub HTTPS observation under local operator custody; saved JSON alone is not an authenticated input" };
  const receiptPath = join(output, "github-observation.json");
  writeFileSync(receiptPath, JSON.stringify(retained, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const receipt = read(receiptPath, 1_048_576);
  // This frame never enters from JSON or a public function argument. Only this
  // fixed-transport collection can apply remote evidence to the local report.
  // Revalidate local package and index bytes after the network observation.
  index.unchanged(); report = evaluateRelease(profile, evidence);
  candidateFrame.unchanged(); collectorFrame.unchanged(); nativeProducer?.unchanged(); lifecycleProducer?.unchanged(); index.unchanged(); checkOutput();
  const gate = report.gates.find(row => row.id === "candidate.required-checks")!;
  if (failure !== null || observation === null) Object.assign(gate, { status: "UNVERIFIABLE", reason: failure ?? "github-observation-unavailable", evidence_sha256: null });
  else {
    const passed = observation.required.every(item => item.status === "PASS");
    Object.assign(gate, { status: passed ? "PASS" : "FAIL", reason: passed ? "github-current-required-jobs-passed" : "github-current-required-jobs-not-passed", evidence_sha256: passed ? receipt.sha256 : null });
  }
  const nativeBinding = failure === null && nativeFailure === null && native?.status === "PASS"
    ? inspectGithubNativeIndexBinding(native.targets, report.evidence) : null;
  for (const target of NATIVE_TARGETS) {
    const row = report.gates.find(item => item.id === `native.${target.target}`)!;
    const status = nativeBinding?.status ?? (native?.status === "FAIL" ? "FAIL" : "UNVERIFIABLE");
    Object.assign(row, { status,
      reason: nativeBinding?.reason ?? failure ?? nativeFailure ?? "github-paired-native-jobs-not-passed", evidence_sha256: status === "PASS" ? receipt.sha256 : null });
  }
  const lifecycleBinding = nativeBinding?.status === "PASS" && lifecycleProducer !== null && lifecycleFailure === null && native !== null
    ? inspectGithubLifecycleIndexBinding(native.targets, report.evidence) : null;
  for (const target of NATIVE_TARGETS) {
    const row = report.gates.find(item => item.id === `lifecycle.${target.target}`)!;
    const status = lifecycleBinding?.status ?? (nativeBinding?.status === "FAIL" ? "FAIL" : "UNVERIFIABLE");
    Object.assign(row, { status, reason: lifecycleBinding?.reason ?? lifecycleFailure ?? nativeBinding?.reason ?? failure ?? nativeFailure ?? "github-current-lifecycle-not-observed", evidence_sha256: status === "PASS" ? receipt.sha256 : null });
  }
  const p0Gate = report.gates.find(row => row.id === "candidate.current-p0-disposition")!;
  if (failure !== null || p0Failure !== null || p0 === null) {
    Object.assign(p0Gate, { status: "UNVERIFIABLE", reason: p0Failure ?? "github-p0-observation-unavailable", evidence_sha256: null });
  } else {
    const binding = inspectGithubP0Disposition(p0);
    Object.assign(p0Gate, { status: binding.status, reason: binding.reason, evidence_sha256: receipt.sha256 });
  }
  const result = { ...report, schema: "kizuki.online-acceptance-report/v1", ...releaseDecision(profile, report.gates), github_observation_sha256: receipt.sha256,
    trust_scope: `${report.trust_scope}; candidate.required-checks, native target facts and current open severity:p0 inventory additionally observed from GitHub during this evaluation; native lifecycle additionally requires independently reviewed producer closure and all17 v2 phases; released-version upgrades, hardware reboot, distribution and human trials are not asserted`,
    online_policy_sha256: hash(JSON.stringify({ schema: "kizuki.github-evidence-policy/v1", repository_id: GITHUB_REPOSITORY_ID, required: REQUIRED, native_targets: NATIVE_TARGETS, native_archive_bytes: GITHUB_ARCHIVE_LIMIT, native_index_binding: "same-target-v3-proof-and-all-seven-package-digests", package_commands: PACKAGE_COMMANDS, native_producer_entrypoints: NATIVE_PRODUCER_ENTRYPOINTS, lifecycle_producer_entrypoints: LIFECYCLE_PRODUCER_ENTRYPOINTS, lifecycle_producer_data: LIFECYCLE_PRODUCER_DATA, lifecycle_registry_sha256: LIFECYCLE_REGISTRY_SHA256, limits: LIMITS, p0_label: P0_LABEL, p0_observation_max_ms: P0_OBSERVATION_MAX_MS, p0_clock_skew_ms: P0_CLOCK_SKEW_MS, selection: "latest-attempt-start-no-pending-ambiguous-refused" })),
    online_verifier_sha256: hash(JSON.stringify(retained.collector_files)) };
  receipt.unchanged();
  writeAcceptanceReport(join(output, "acceptance-report.json"), result);
  return result;
}

export function parseGithubEvidenceArgs(args: readonly string[]): { profile: "rc" | "1.0"; evidence: string; checkout: string; out: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--profile", "--evidence", "--checkout", "--out"].includes(key) || !value || value.startsWith("--") || flags.has(key)) reject("invalid-arguments");
    flags.set(key, value);
  }
  const profile = flags.get("--profile");
  if (flags.size !== 4 || (profile !== "rc" && profile !== "1.0")) reject("invalid-arguments");
  return { profile, evidence: absolute(flags.get("--evidence")), checkout: absolute(flags.get("--checkout")), out: absolute(flags.get("--out")) };
}
if (import.meta.main) {
  try {
    const args = parseGithubEvidenceArgs(Bun.argv.slice(2));
    const report = await evaluateReleaseOnline(args.profile, args.evidence, args.checkout, args.out);
    process.stdout.write(JSON.stringify(report) + "\n"); process.exitCode = report.decision === "GO" ? 0 : 1;
  } catch {
    process.stderr.write("github-evidence-failed: use --profile rc|1.0 --evidence ABSOLUTE_FILE --checkout CLEAN_CANDIDATE --out NEW_DIRECTORY\n");
    process.exitCode = 2;
  }
}
