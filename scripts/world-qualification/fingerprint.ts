import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson, sha256 } from "../evaluate-extraction";

export const RUNNER_FILES = [
  "scripts/world-qualification/candidate-modules.ts", "scripts/world-qualification/pacing.ts", "scripts/world-qualification/resume.ts",
  "scripts/world-qualification/run.ts", "scripts/world-qualification/score.ts", "scripts/world-qualification/registry.ts",
  "scripts/world-qualification/fingerprint.ts", "scripts/world-qualification/corpus.ts", "scripts/world-qualification/corpus-v1.ts", "scripts/world-qualification/corpus-v2.ts", "scripts/world-qualification/corpus-v3.ts", "scripts/world-qualification/corpus-v3.json", "scripts/world-qualification/corpus-v3-freeze.json", "scripts/world-qualification/preexisting.json",
  "scripts/world-qualification/corpus-v5-core.ts", "scripts/world-qualification/corpus-v5-core.json",
  "scripts/world-qualification/corpus-v5-core-semantic-oracle.json", "scripts/world-qualification/corpus-v5-core-freeze.json",
  "scripts/world-qualification/corpus-v5-core-author.md", "scripts/world-qualification/corpus-v5-core-author-validation.json",
  "scripts/world-qualification/supplemental.ts", "scripts/world-qualification/core-semantic.ts", "scripts/world-qualification/wire-custody.ts",
  "scripts/world-qualification/verify-core-semantic.ts", "scripts/world-qualification/input-planning.ts", "scripts/world-qualification/core-semantic-v3.md",
  "scripts/world-qualification/core-semantic-corpus.json", "scripts/world-qualification/core-semantic-contract.json",
  "scripts/world-qualification/core-semantic-freeze.json", "scripts/world-qualification/core-semantic.md",
  "scripts/evaluate-extraction.ts", "packages/core/src/producer/model-v2.ts", "packages/core/src/producer/model-v2-wire.ts", "packages/core/src/producer/prompt-v2.ts", "packages/core/src/producer/fingerprint.ts",
  "packages/core/src/producer/index.ts", "packages/core/src/producer/model.ts", "packages/core/src/producer/fence.ts", "packages/core/src/producer/result.ts", "packages/core/src/producer/systemone-admit.ts",
  "packages/core/src/contracts/llm.ts", "packages/core/src/contracts/ports.ts", "packages/core/src/contracts/registry.ts",
  "packages/core/src/producer/world-drafts.ts", "packages/core/src/producer/world-guards.ts", "packages/core/src/producer/scrub.ts",
  "packages/core/src/util/hash.ts", "packages/core/src/util/validate.ts",
  "packages/core/src/world/tables/versions.ts", "packages/core/src/serve/extract-replay-schema.ts",
  "packages/core/src/ledger/db.ts", "packages/core/src/world/registry-check.ts", "packages/core/src/world/framework-cycles.ts",
  "packages/core/src/claims/occurrences.ts", "packages/core/src/contracts/claim-v2.ts", "packages/core/src/contracts/world-admission.ts",
  "packages/core/src/serve/extract-replay.ts", "packages/core/src/export.ts", "packages/core/src/serve/receipts.ts",
  "packages/core/src/serve/types.ts", "packages/core/src/serve/config.ts", "packages/core/src/serve/budget-ledger.ts",
  "packages/core/src/serve/write-pass.ts", "packages/core/src/serve/world-grounding.ts", "packages/core/src/serve/consolidate.ts",
  "packages/cli/src/serve-runtime.ts", "packages/core/src/index.ts",
  "packages/core/src/serve/extract.ts", "packages/core/src/serve/extract-oversized.ts", "packages/core/src/serve/extract-v2.ts", "packages/core/src/contracts/producer-v2.ts", "packages/llm/src/openai-compatible.ts",
  "packages/llm/src/index.ts", "packages/llm/src/transport.ts", "packages/llm/src/response.ts", "packages/llm/src/config.ts",
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
