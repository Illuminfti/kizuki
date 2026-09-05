import { lstatSync, readFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid CI event shape");
  return value as Record<string, unknown>;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("missing or invalid event commit SHA");
  return value;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("required Git object or operation unavailable; full event history is required");
  return result.stdout.toString().trim();
}

function main(): void {
  const path = process.env["GITHUB_EVENT_PATH"];
  if (!path) throw new Error("GITHUB_EVENT_PATH is required");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 26 * 1024 * 1024) throw new Error("CI event must be a bounded regular file");
  const event = record(JSON.parse(readFileSync(path, "utf8")));
  const kind = process.env["GITHUB_EVENT_NAME"];
  let before: string;
  let after: string;
  if (kind === "pull_request") {
    const pr = record(event["pull_request"]);
    before = sha(record(pr["base"])["sha"]);
    after = sha(record(pr["head"])["sha"]);
    if (before === ZERO) throw new Error("pull request base cannot be zero");
  } else if (kind === "push") {
    before = sha(event["before"]);
    after = sha(event["after"]);
  } else if (kind === "workflow_dispatch") {
    before = sha(record(event["inputs"])["base_sha"]);
    after = sha(process.env["GITHUB_SHA"]);
    if (before === ZERO || before === after) throw new Error("manual proof requires a distinct nonzero ancestor base");
    git("rev-parse", "--verify", `${before}^{commit}`);
    git("merge-base", "--is-ancestor", before, after);
  } else {
    throw new Error("unsupported CI event; define an explicit diff contract");
  }
  if (after === ZERO || git("rev-parse", "--verify", "HEAD") !== after) {
    throw new Error("checkout must equal the event head; refusing a stale or merge checkout");
  }
  git("rev-parse", "--verify", `${after}^{commit}`);
  let base: string;
  if (before === ZERO) {
    // Object-format independent empty tree, with no shell interpolation or ref lookup.
    const empty = Bun.spawnSync(["git", "hash-object", "-w", "-t", "tree", "--stdin"], {
      stdin: new Uint8Array(), stdout: "pipe", stderr: "pipe",
    });
    if (empty.exitCode !== 0) throw new Error("cannot construct initial-push empty tree");
    base = empty.stdout.toString().trim();
  } else {
    git("rev-parse", "--verify", `${before}^{commit}`);
    base = kind === "pull_request" ? git("merge-base", before, after) : before;
  }
  console.log(`diff integrity: ${kind} ${base}..${after}`);
  const checked = Bun.spawnSync(["git", "diff", "--check", "--no-ext-diff", "--no-textconv", base, after, "--"], {
    stdout: "inherit", stderr: "inherit",
  });
  if (checked.exitCode !== 0) process.exitCode = 1;
}

try { main(); } catch (error) {
  console.error(`diff integrity refused: ${error instanceof Error ? error.message : "invalid event"}`);
  process.exitCode = 1;
}
