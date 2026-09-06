import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BUN_VERSION = readFileSync(resolve(ROOT, ".bun-version"), "utf8").trim();

export interface WorkflowFailure {
  path: string;
  reason: string;
}

const ACTION_PIN = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?)@[0-9a-f]{40}$/;
const WORKFLOW_NAME = /\.(?:ya?ml)$/;
const VERIFY_COMMAND = /(?:bun run verify|scripts\/verify\.sh|bun run ci:secrets|scripts\/verify-secrets\.ts)/;
const SETUP_BUN = /setup-bun@/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walk(
  value: unknown,
  visit: (record: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function parseWorkflowYaml(text: string): unknown {
  return Bun.YAML.parse(text);
}

function jobRunsHistoryScan(job: Record<string, unknown>): boolean {
  const steps = job["steps"];
  if (!Array.isArray(steps)) return false;
  return steps.some((step) => {
    if (!isRecord(step)) return false;
    const run = step["run"];
    return typeof run === "string" && VERIFY_COMMAND.test(run);
  });
}

function jobHasFullHistoryCheckout(job: Record<string, unknown>): boolean {
  const steps = job["steps"];
  if (!Array.isArray(steps)) return false;
  return steps.some((step) => {
    if (!isRecord(step)) return false;
    const uses = step["uses"];
    if (typeof uses !== "string" || !uses.startsWith("actions/checkout@")) {
      return false;
    }
    const withField = step["with"];
    return isRecord(withField) && withField["fetch-depth"] === 0;
  });
}

function validateJobs(
  path: string,
  jobs: Record<string, unknown>,
): WorkflowFailure[] {
  const failures: WorkflowFailure[] = [];
  const names = Object.keys(jobs);
  if (names.length === 0) {
    failures.push({ path, reason: "workflow has no jobs" });
    return failures;
  }

  for (const [name, rawJob] of Object.entries(jobs)) {
    if (!isRecord(rawJob)) {
      failures.push({ path, reason: `job "${name}" is not a mapping` });
      continue;
    }
    if (rawJob["runs-on"] === undefined && rawJob["uses"] === undefined) {
      failures.push({ path, reason: `job "${name}" has no runs-on` });
    }
    const timeout = rawJob["timeout-minutes"];
    if (typeof timeout !== "number" || timeout < 1) {
      failures.push({
        path,
        reason: `job "${name}" must set timeout-minutes to a positive number`,
      });
    }
    const steps = rawJob["steps"];
    if (rawJob["uses"] === undefined && (!Array.isArray(steps) || steps.length === 0)) {
      failures.push({ path, reason: `job "${name}" has no steps` });
    }
    if (jobRunsHistoryScan(rawJob) && !jobHasFullHistoryCheckout(rawJob)) {
      failures.push({
        path,
        reason: `job "${name}" runs the repository gate without checkout fetch-depth 0`,
      });
    }
    if ((path.endsWith("/ci.yml") || path.endsWith("/macos-native.yml")) && Array.isArray(steps)) {
      const checkouts = steps.filter(step => isRecord(step) && typeof step["uses"] === "string" && step["uses"].startsWith("actions/checkout@"));
      const exact = (checkout: unknown): boolean => {
        const settings = isRecord(checkout) ? checkout["with"] : undefined;
        return isRecord(settings) && settings["ref"] === "${{ github.event.pull_request.head.sha || github.sha }}" &&
          (!jobRunsHistoryScan(rawJob) || settings["fetch-depth"] === 0);
      };
      if (((name === "test" || jobRunsHistoryScan(rawJob)) && checkouts.length === 0) || !checkouts.every(exact)) {
        failures.push({ path, reason: `job "${name}" must check out the immutable event head` });
      }
      if (name === "test" && (rawJob["if"] !== undefined || !steps.some(step =>
        isRecord(step) && step["if"] === undefined && step["run"] === "bun scripts/ci-diff-check.ts"))) {
        failures.push({ path, reason: "ci test must run the unconditional event-bound diff checker" });
      }
    }
  }

  if (path.endsWith("/ci.yml") || path.endsWith(".github/workflows/ci.yml")) {
    if (!("test" in jobs)) {
      failures.push({
        path,
        reason: 'ci.yml must keep job "test" so existing pull requests keep ci / test',
      });
    }
  }
  return failures;
}

const UPLOAD_ARTIFACT_ACTION =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const SUCCESS_PRECONDITION = "${{ success() }}";
const LINUX_PROOF_COMMAND =
  'bun run build:release\nbun run smoke:release\nbun run proof:artifact -- --report "$RUNNER_TEMP/kizuki-artifact-proof"';
const LINUX_RECEIPT_CHECK = 'test -f "$RUNNER_TEMP/kizuki-artifact-proof/receipt.json"';
const LINUX_ARTIFACT_NAME = "linux-x64-${{ github.event.pull_request.head.sha || github.sha }}";
const LINUX_ARTIFACT_PATH =
  "dist/kizuki-*/bun-linux-x64-baseline/\n${{ runner.temp }}/kizuki-artifact-proof/receipt.json";
const MACOS_PROOF_COMMAND =
  'bun run build:release\nbun run smoke:release\nbun run proof:artifact -- --report "$RUNNER_TEMP/kizuki-macos-artifact-proof"';
const MACOS_RECEIPT_CHECK = 'test -f "$RUNNER_TEMP/kizuki-macos-artifact-proof/receipt.json"';
const MACOS_ARTIFACT_NAME = "macos-arm64-${{ github.sha }}";
const MACOS_ARTIFACT_PATH =
  "dist/kizuki-*/bun-darwin-arm64/\n${{ runner.temp }}/kizuki-macos-artifact-proof/receipt.json";

function commandLines(value: unknown): string {
  return typeof value === "string" ? value.trim().split("\n").map(line => line.trim()).join("\n") : "";
}

function isBareCommand(step: unknown, command: string): boolean {
  return isRecord(step) && Object.keys(step).every(key => ["name", "run"].includes(key)) &&
    commandLines(step["run"]) === command;
}

function isUploadArtifactStep(step: unknown): boolean {
  return isRecord(step) && typeof step["uses"] === "string" &&
    step["uses"].startsWith("actions/upload-artifact@");
}

function isNativeArtifactUpload(step: unknown, artifactName: string, artifactPath: string): boolean {
  if (!isRecord(step) || !Object.keys(step).every(key => ["name", "uses", "with", "if"].includes(key)) ||
      step["uses"] !== UPLOAD_ARTIFACT_ACTION || step["if"] !== SUCCESS_PRECONDITION ||
      !isRecord(step["with"])) return false;
  const actual = step["with"];
  const expected: Record<string, unknown> = {
    name: artifactName,
    path: artifactPath,
    "retention-days": 7,
    "if-no-files-found": "error",
  };
  return Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) =>
      typeof value === "string" ? commandLines(actual[key]) === value : actual[key] === value);
}

// This bounded manual proof has an ordered, closed execution contract. Names are
// cosmetic; run bodies, action configuration and failure propagation are not.
function hasMacNativeProof(document: Record<string, unknown>, job: Record<string, unknown>): boolean {
  const steps = job["steps"];
  if (!Array.isArray(steps) || steps.length !== 9 || document["env"] !== undefined || document["defaults"] !== undefined ||
      job["defaults"] !== undefined || !isRecord(job["env"]) ||
      Object.keys(job["env"]).join() !== "KIZUKI_TARGET" || job["env"]["KIZUKI_TARGET"] !== "bun-darwin-arm64") return false;
  const action = (index: number, prefix: string, settings: Record<string, unknown>, condition?: string): boolean => {
    const step = steps[index];
    if (!isRecord(step) || !Object.keys(step).every(key => ["name", "uses", "with", "if"].includes(key)) ||
        typeof step["uses"] !== "string" || !step["uses"].startsWith(prefix + "@") || step["if"] !== condition || !isRecord(step["with"])) return false;
    const actual = step["with"];
    return Object.keys(actual).length === Object.keys(settings).length && Object.entries(settings).every(([key, value]) =>
      typeof value === "string" ? commandLines(actual[key]) === value : actual[key] === value);
  };
  return action(0, "actions/checkout", { "fetch-depth": 0, ref: "${{ github.event.pull_request.head.sha || github.sha }}" }) &&
    isBareCommand(steps[1], "bash scripts/ci-restrict-origin-refs.sh") &&
    action(2, "oven-sh/setup-bun", { "bun-version": BUN_VERSION }) &&
    isBareCommand(steps[3], "bun scripts/ci-diff-check.ts") &&
    isBareCommand(steps[4], 'test "$(uname -s)" = Darwin\ntest "$(uname -m)" = arm64\nbun install --frozen-lockfile') &&
    isBareCommand(steps[5], "bun run typecheck\nbun test scripts/release-targets.test.ts scripts/release-artifacts.test.ts scripts/stranger-proof.test.ts packages/core/test/serve/advisory-file-lock.test.ts packages/core/test/serve/flock.test.ts packages/core/test/serve/leases.test.ts packages/core/test/serve/units.test.ts packages/core/test/serve/service-arguments.test.ts packages/cli/test/config.test.ts packages/cli/test/terminal-prompt.test.ts packages/tui/test/terminal.test.ts packages/retrieval-pg/test/contention.test.ts scripts/native-platform.test.ts") &&
    isBareCommand(steps[6], MACOS_PROOF_COMMAND) &&
    isBareCommand(steps[7], MACOS_RECEIPT_CHECK) &&
    isNativeArtifactUpload(steps[8], MACOS_ARTIFACT_NAME, MACOS_ARTIFACT_PATH);
}

function hasLinuxNativeProof(document: Record<string, unknown>, job: Record<string, unknown>): boolean {
  const steps = job["steps"];
  if (!Array.isArray(steps) || steps.length < 4 || document["defaults"] !== undefined ||
      job["defaults"] !== undefined) return false;
  const suffix = steps.length - 4;
  return isBareCommand(steps[suffix], LINUX_PROOF_COMMAND) &&
    isBareCommand(steps[suffix + 1], "bun scripts/ci-diff-check.ts") &&
    isBareCommand(steps[suffix + 2], LINUX_RECEIPT_CHECK) &&
    steps.filter(isUploadArtifactStep).length === 1 &&
    isNativeArtifactUpload(steps[steps.length - 1], LINUX_ARTIFACT_NAME, LINUX_ARTIFACT_PATH);
}

export function validateWorkflowText(path: string, text: string): WorkflowFailure[] {
  if (text.trim().length === 0) {
    return [{ path, reason: "workflow file is empty" }];
  }

  let document: unknown;
  try {
    document = parseWorkflowYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "parse error";
    return [{ path, reason: `invalid YAML: ${detail}` }];
  }

  if (!isRecord(document)) {
    return [{ path, reason: "workflow document must be a mapping" }];
  }

  const failures: WorkflowFailure[] = [];
  if (!("on" in document)) {
    failures.push({ path, reason: "workflow is missing on:" });
  }
  if (path.endsWith("/ci.yml") || path.endsWith(".github/workflows/ci.yml")) {
    if (document["name"] !== "ci") {
      failures.push({ path, reason: 'ci.yml name must remain "ci"' });
    }
    const jobs = document["jobs"];
    const job = isRecord(jobs) ? jobs["test"] : undefined;
    if (isRecord(job) && !hasLinuxNativeProof(document, job)) {
      failures.push({
        path,
        reason: "ci test must verify the native proof receipt before retaining the Linux package",
      });
    }
  }

  if (path.endsWith("/macos-native.yml")) {
    const trigger = document["on"];
    const dispatch = isRecord(trigger) ? trigger["workflow_dispatch"] : undefined;
    const inputs = isRecord(dispatch) ? dispatch["inputs"] : undefined;
    const allowance = isRecord(inputs) ? inputs["existing_allowance_verified"] : undefined;
    const base = isRecord(inputs) ? inputs["base_sha"] : undefined;
    const jobs = document["jobs"];
    const job = isRecord(jobs) ? jobs["native-arm64"] : undefined;
    const steps = isRecord(job) ? job["steps"] : undefined;
    if (!isRecord(trigger) || Object.keys(trigger).join() !== "workflow_dispatch" ||
        !isRecord(allowance) || allowance["type"] !== "boolean" || allowance["default"] !== false || allowance["required"] !== true ||
        !isRecord(base) || base["type"] !== "string" || base["required"] !== true ||
        !isRecord(jobs) || Object.keys(jobs).join() !== "native-arm64" || !isRecord(job) ||
        job["if"] !== "${{ inputs.existing_allowance_verified == true }}" || job["runs-on"] !== "macos-15" || job["timeout-minutes"] !== 15 || job["strategy"] !== undefined ||
        !hasMacNativeProof(document, job) || !Array.isArray(steps) || !steps.some(step => isRecord(step) && step["if"] === undefined && step["run"] === "bun scripts/ci-diff-check.ts") ||
        !steps.some(step => isRecord(step) && typeof step["uses"] === "string" && step["uses"].startsWith("actions/checkout@"))) {
      failures.push({ path, reason: "macOS proof must retain its manual allowance gate, native tests, immutable build and retained artifact proof" });
    }
  }

  const jobs = document["jobs"];
  if (!isRecord(jobs)) {
    failures.push({ path, reason: "workflow has no jobs" });
  } else {
    failures.push(...validateJobs(path, jobs));
  }

  walk(document, (record) => {
    if (record["continue-on-error"] === true) {
      failures.push({
        path,
        reason: "continue-on-error would allow a fake pass",
      });
    }
    const uses = record["uses"];
    if (typeof uses === "string" && !uses.startsWith("./") && !ACTION_PIN.test(uses)) {
      failures.push({ path, reason: `unpinned action: ${uses}` });
    }
    if (typeof uses === "string" && SETUP_BUN.test(uses)) {
      const withField = record["with"];
      const bunVersion = isRecord(withField) ? withField["bun-version"] : undefined;
      if (bunVersion !== BUN_VERSION) {
        failures.push({
          path,
          reason: `setup-bun must pin bun-version to ${BUN_VERSION}`,
        });
      }
    }
    const condition = record["if"];
    if (typeof condition === "string" && /hashFiles\s*\(/.test(condition)) {
      failures.push({
        path,
        reason: "skip-on-missing hashFiles condition is not allowed",
      });
    }
  });

  return failures;
}

export async function validateTrackedWorkflows(opts?: {
  workflowsDir?: string;
}): Promise<WorkflowFailure[]> {
  const workflowsDir = opts?.workflowsDir ?? ".github/workflows";
  const listed = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--", workflowsDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) {
    return [{
      path: workflowsDir,
      reason: `tracked workflow producer exited ${listed.exitCode}`,
    }];
  }
  const files = listed.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0 && WORKFLOW_NAME.test(file));
  if (files.length === 0) {
    return [{ path: workflowsDir, reason: "no tracked workflow files" }];
  }

  const failures: WorkflowFailure[] = [];
  for (const file of files) {
    failures.push(...validateWorkflowText(file, await Bun.file(file).text()));
  }
  return failures;
}

export function validateToolchain(root = ROOT, runtime = Bun.version): WorkflowFailure[] {
  try {
    const version = readFileSync(resolve(root, ".bun-version"), "utf8").trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("invalid .bun-version");
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const parsedLock = Bun.JSON5.parse(readFileSync(resolve(root, "bun.lock"), "utf8"));
    const requireRecord = (value: unknown): Record<string, unknown> => {
      if (!isRecord(value)) throw new Error("invalid toolchain metadata");
      return value;
    };
    const lock = requireRecord(parsedLock);
    const workspace = requireRecord(requireRecord(lock["workspaces"])[""]);
    const packages = requireRecord(lock["packages"]);
    const types = packages["@types/bun"];
    const runtimeTypes = packages["bun-types"];
    const failures: WorkflowFailure[] = [];
    const check = (ok: boolean, path: string, reason: string) => { if (!ok) failures.push({ path, reason }); };
    check(runtime === version, ".bun-version", `verification requires Bun ${version}`);
    check(pkg?.packageManager === `bun@${version}`, "package.json", "packageManager must match .bun-version exactly");
    check(pkg?.engines?.bun === version, "package.json", "engines.bun must match .bun-version exactly");
    check(pkg?.devDependencies?.["@types/bun"] === version, "package.json", "Bun runtime types must match .bun-version exactly");
    check(requireRecord(workspace["devDependencies"])["@types/bun"] === version,
      "bun.lock", "locked workspace runtime types must match .bun-version");
    check(Array.isArray(types) && types[0] === `@types/bun@${version}` &&
      requireRecord(requireRecord(types[2])["dependencies"])["bun-types"] === version &&
      Array.isArray(runtimeTypes) && runtimeTypes[0] === `bun-types@${version}`,
      "bun.lock", "resolved Bun runtime types must match .bun-version exactly");
    return failures;
  } catch {
    return [{ path: root, reason: "toolchain metadata is missing or malformed" }];
  }
}

async function main(): Promise<void> {
  const failures = [...validateToolchain(), ...await validateTrackedWorkflows()];
  for (const failure of failures) {
    console.error(`${failure.path}: ${failure.reason}`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("workflow verification passed");
}

if (import.meta.main) {
  await main();
}
