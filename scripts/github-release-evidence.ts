/** Explicit online GitHub observation. Saved JSON is never a trusted input. */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateRelease, releaseDecision, writeAcceptanceReport } from "./go-no-go";
import { absolute, assertCheckoutCustody, assertProductCheckoutCustody, digest, EVALUATOR_ROOT, EvidenceError, hash, parents, read, reject } from "./release-evidence";
import { parseProofJson } from "./proof-json";
import { validateToolchain, validateWorkflowText } from "./verify-workflows";

export const GITHUB_REPOSITORY_ID = 1353875622;
interface GithubRepository { id: typeof GITHUB_REPOSITORY_ID; full_name: string; }
const PAGE_SIZE = 25;
const LIMITS = { json_bytes: 1_048_576, pages: 20, attempts: 10, jobs: 100, requests: 256, total_ms: 300_000, timeout_ms: 30_000 } as const;
const REQUIRED = [
  { path: ".github/workflows/ci.yml", jobs: ["test", "secrets"] },
  { path: ".github/workflows/workflows.yml", jobs: ["workflows"] },
] as const;
const CANDIDATE_FILES = [".bun-version", "package.json", "bun.lock", "tsconfig.json", ...REQUIRED.map(item => item.path)];
const COLLECTOR_FILES = [...CANDIDATE_FILES, "scripts/github-release-evidence.ts", "scripts/go-no-go.ts", "scripts/release-evidence.ts", "scripts/verify-workflows.ts", "scripts/proof-json.ts"];
type JsonObject = Record<string, unknown>;
type GetJson = (endpoint: string) => Promise<unknown>;
interface Run {
  id: number; run_number: number; run_attempt: number; workflow_id: number; path: string; head_sha: string;
  event: string; status: string; conclusion: string | null; created_at: string; updated_at: string; run_started_at: string;
}
interface Job {
  id: number; run_id: number; run_attempt: number; head_sha: string; name: string; status: string; conclusion: string | null;
  steps: { name: string; number: number; status: string; conclusion: string | null }[];
}
export interface GithubCandidateObservation {
  schema: "kizuki.github-candidate-observation/v1"; repository: GithubRepository; candidate_source_sha: string;
  inventory: Run[]; attempts: { run_id: number; attempt: number; status: string; conclusion: string | null; path: string; run_started_at: string; created_at: string; updated_at: string }[];
  required: { path: string; run: Run | null; jobs: Job[]; status: "PASS" | "FAIL" | "MISSING"; reason: string }[];
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
  if (!Array.isArray(row.steps) || row.steps.length < 1 || row.steps.length > 100) reject("github-invalid-steps");
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
// GitHub's run keeps its original created_at, whereas attempt created_at changes
// on rerun. All current-attempt fields, including run_started_at, must agree.
function sameLatestAttempt(observed: Run, current: Run): boolean {
  const { created_at: _attemptCreated, ...attempt } = observed;
  const { created_at: _runCreated, ...run } = current;
  return same(attempt, run);
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

/** Evidence analysis is testable, but its result is untrusted until the private
 * online entrypoint obtains it from the fixed GitHub transport and binds source. */
export async function inspectGithubCandidate(transport: GetJson, candidate: string, workflows: ReadonlyMap<string, string>): Promise<GithubCandidateObservation> {
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
  for (const requirement of REQUIRED) {
    const histories = before.filter(row => row.path === requirement.path);
    const workflowAttempts: Run[] = [];
    // Every bounded attempt is retained. An old run's fresh rerun can supersede
    // a newer run number, and any still-pending attempt prevents gate credit.
    let pending = false;
    for (const historical of histories) {
      if (!["push", "pull_request"].includes(historical.event)) reject("github-workflow-event-mismatch");
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
    if (jobs.length !== requirement.jobs.length) ok = false;
    for (const name of requirement.jobs) {
      const actual = jobs.find(item => item.name === name);
      const definition = object(configured[name]);
      if (!actual || actual.status !== "completed" || actual.conclusion !== "success") { ok = false; continue; }
      if (!Array.isArray(definition.steps)) reject("github-candidate-workflow-invalid");
      for (let index = 0; index < definition.steps.length; index++) {
        const step = object(definition.steps[index]);
        const expectedName = step.name ?? (typeof step.uses === "string" ? `Run ${step.uses}` : null);
        if (typeof expectedName !== "string") reject("github-unbound-step-name");
        const observed = actual.steps.find(item => item.number === index + 2);
        if (!observed || observed.name !== expectedName || observed.status !== "completed" || observed.conclusion !== "success") ok = false;
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

function ghJson(endpoint: string): Buffer {
  if ((endpoint !== `/repositories/${GITHUB_REPOSITORY_ID}` && !/^\/repos\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/actions\//.test(endpoint)) || !/^[/A-Za-z0-9_.?=&-]+$/.test(endpoint)) reject("github-endpoint-refused");
  try {
    return execFileSync("gh", ["api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", endpoint],
      { maxBuffer: LIMITS.json_bytes, timeout: LIMITS.timeout_ms, stdio: ["ignore", "pipe", "pipe"] });
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
  const workflows = new Map(REQUIRED.map(item => [item.path, candidateFrame.files.find(file => file.path === item.path)!.bytes.toString("utf8")]));
  const checkOutputParent = parents(output);
  mkdirSync(output, { mode: 0o700 }); checkOutputParent();
  const checkOutput = parents(join(output, "github-observation.json"));
  const raw: { path: string; endpoint: string; sha256: string; bytes: number }[] = [];
  const started = new Date().toISOString();
  let observation: GithubCandidateObservation | null = null;
  let failure: string | null = null;
  try {
    observation = await inspectGithubCandidate(async endpoint => {
      const bytes = ghJson(endpoint), name = `github-${String(raw.length + 1).padStart(4, "0")}.json`;
      writeFileSync(join(output, name), bytes, { flag: "wx", mode: 0o600 });
      raw.push({ path: name, endpoint, sha256: hash(bytes), bytes: bytes.length });
      return parseProofJson(bytes);
    }, candidate, workflows);
    candidateFrame.unchanged(); collectorFrame.unchanged(); index.unchanged(); checkOutput();
  } catch (error) { failure = error instanceof EvidenceError ? error.reason : "github-observation-unavailable"; }
  const retained = { schema: "kizuki.github-collection/v1", candidate_source_sha: candidate, collector_source_sha: collectorHead,
    candidate_files: candidateFrame.files.map(({ path, sha256 }) => ({ path, sha256 })), collector_files: collectorFrame.files.map(({ path, sha256 }) => ({ path, sha256 })),
    started_at: started, completed_at: new Date().toISOString(), raw, observation, failure,
    trust_scope: "fresh GitHub HTTPS observation under local operator custody; saved JSON alone is not an authenticated input" };
  const receiptPath = join(output, "github-observation.json");
  writeFileSync(receiptPath, JSON.stringify(retained, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const receipt = read(receiptPath, 1_048_576);
  // This frame never enters from JSON or a public function argument. Only this
  // fixed-transport collection can apply remote evidence to the local report.
  // Revalidate local package and index bytes after the network observation.
  index.unchanged(); report = evaluateRelease(profile, evidence);
  candidateFrame.unchanged(); collectorFrame.unchanged(); index.unchanged(); checkOutput();
  const gate = report.gates.find(row => row.id === "candidate.required-checks")!;
  if (failure !== null || observation === null) Object.assign(gate, { status: "UNVERIFIABLE", reason: failure ?? "github-observation-unavailable", evidence_sha256: null });
  else {
    const passed = observation.required.every(item => item.status === "PASS");
    Object.assign(gate, { status: passed ? "PASS" : "FAIL", reason: passed ? "github-current-required-jobs-passed" : "github-current-required-jobs-not-passed", evidence_sha256: passed ? receipt.sha256 : null });
  }
  const result = { ...report, schema: "kizuki.online-acceptance-report/v1", ...releaseDecision(profile, report.gates), github_observation_sha256: receipt.sha256,
    trust_scope: `${report.trust_scope}; candidate.required-checks additionally observed from GitHub during this evaluation`,
    online_policy_sha256: hash(JSON.stringify({ schema: "kizuki.github-evidence-policy/v1", repository_id: GITHUB_REPOSITORY_ID, required: REQUIRED, limits: LIMITS, selection: "latest-attempt-start-no-pending-ambiguous-refused" })),
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
