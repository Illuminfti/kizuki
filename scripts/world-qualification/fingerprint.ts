import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson, sha256 } from "../evaluate-extraction";

export const RUNNER_FILES = [
  "scripts/world-qualification/candidate-modules.ts", "scripts/world-qualification/pacing.ts", "scripts/world-qualification/resume.ts",
  "scripts/world-qualification/run.ts", "scripts/world-qualification/score.ts", "scripts/world-qualification/registry.ts",
  "scripts/world-qualification/fingerprint.ts", "scripts/world-qualification/corpus.ts", "scripts/world-qualification/preexisting.json",
  "scripts/evaluate-extraction.ts", "packages/core/src/producer/model-v2.ts", "packages/core/src/producer/prompt-v2.ts",
  "packages/core/src/serve/extract-v2.ts", "packages/core/src/contracts/producer-v2.ts", "packages/llm/src/openai-compatible.ts",
  "packages/llm/src/transport.ts", "packages/llm/src/response.ts", "packages/llm/src/config.ts",
] as const;
export const runnerDigest = (root = resolve(import.meta.dir, "../..")) => sha256(canonicalJson(RUNNER_FILES.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) }))));
export const SOURCE_FILES = [...RUNNER_FILES, "scripts/world-qualification/approvals.ts"] as const;

/** Untracked runner files must not inherit the clean commit of their surrounding checkout. */
export function sourceProvenance(root = resolve(import.meta.dir, "../..")) {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
  const head = git("rev-parse", "HEAD"), status = git("status", "--porcelain", "--untracked-files=no");
  const tracked = git("ls-files", "--error-unmatch", "--", ...SOURCE_FILES);
  const commit = head.stdout.toString().trim();
  return { source_commit: commit, source_clean: head.exitCode === 0 && /^[a-f0-9]{40}$/.test(commit) &&
    status.exitCode === 0 && status.stdout.length === 0 && tracked.exitCode === 0 };
}
