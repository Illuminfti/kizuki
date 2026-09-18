/** P0-disposition producer: the open severity:p0 inventory for an exact candidate. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { FAMILY_LIMITS, P0_DISPOSITION_PRODUCER, P0_DISPOSITION_PRODUCER_FILES, P0_LABEL, digest, evaluatorRevision, receiptInstant, recordedAt, reject } from "./release-evidence";

const GIT_TIMEOUT_MS = 30_000;

export interface ObservedP0Issue { number: number; updated_at: string }
export interface P0DispositionReceiptInput {
  candidate_source_sha: string;
  /** Checkout whose producer-file bytes the receipt binds. */
  root: string;
  /** Commit time of the candidate, read from a checkout that holds it. */
  candidate_committed_at: string;
  snapshot_at: string;
  open_issues: readonly ObservedP0Issue[];
  attempt_id?: string; recorded_at?: string;
}

/** Commit time of the candidate as its own checkout records it. The evaluator
 * may not hold that commit, so the producer binds this time and the evaluator
 * only enforces that the findings snapshot does not predate it. */
export function candidateCommittedAt(root: string, candidateSha: string): string {
  digest(candidateSha, 40);
  let raw;
  try {
    raw = execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "show", "-s", "--format=%cI", `${candidateSha}^{commit}`],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  } catch { reject("candidate-commit-time-unavailable"); }
  return receiptInstant(raw.trim());
}

export function p0DispositionReceipt(input: P0DispositionReceiptInput) {
  if (input.open_issues.length > FAMILY_LIMITS.issues) reject("p0-inventory-limit");
  return {
    schema: P0_DISPOSITION_PRODUCER,
    identity: {
      candidate_source_sha: digest(input.candidate_source_sha, 40),
      producer: P0_DISPOSITION_PRODUCER,
      producer_revision: evaluatorRevision(input.root)(P0_DISPOSITION_PRODUCER_FILES),
      producer_files: [...P0_DISPOSITION_PRODUCER_FILES],
      source_class: "findings-snapshot",
      actor_class: "retained-ci-snapshot",
      attempt_id: input.attempt_id ?? randomUUID(),
      recorded_at: recordedAt(input.recorded_at ?? new Date().toISOString()),
    },
    label: P0_LABEL,
    candidate_committed_at: recordedAt(input.candidate_committed_at),
    snapshot_at: recordedAt(input.snapshot_at),
    open_issues: input.open_issues.map(issue => ({ number: issue.number, updated_at: receiptInstant(issue.updated_at) })),
  };
}
