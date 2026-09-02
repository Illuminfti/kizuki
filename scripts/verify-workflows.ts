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
      if (bunVersion !== "1.3.10") {
        failures.push({
          path,
          reason: "setup-bun must pin bun-version to 1.3.10",
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

async function main(): Promise<void> {
  const failures = await validateTrackedWorkflows();
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
