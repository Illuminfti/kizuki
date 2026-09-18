/** Required-checks producer: the exact candidate's three branch-protection contexts. */
import { randomUUID } from "node:crypto";
import { REQUIRED_CHECKS_PRODUCER, REQUIRED_CHECKS_PRODUCER_FILES, REQUIRED_CONTEXTS, digest, evaluatorRevision, receiptInstant, recordedAt, reject } from "./release-evidence";

/** What this producer reads from an online required-workflow observation. */
export interface ObservedRequiredWorkflow {
  path: string; run: { id: number; updated_at: string } | null;
  jobs: readonly { name: string; conclusion: string | null }[];
}
export interface RequiredCheckContext { context: string; conclusion: string; run_id: number; completed_at: string }
export interface RequiredChecksReceiptInput {
  candidate_source_sha: string;
  /** Checkout whose producer-file bytes the receipt binds. */
  root: string;
  contexts: readonly RequiredCheckContext[];
  attempt_id?: string; recorded_at?: string;
}

/** Project observed required workflows onto exactly the three required contexts.
 * A context without a concluded observation is refused rather than guessed; an
 * omitted or invented context cannot be evaluated. */
export function requiredChecksContexts(rows: readonly ObservedRequiredWorkflow[]): RequiredCheckContext[] {
  const observed = new Map<string, RequiredCheckContext>();
  for (const row of rows) {
    if (row.run === null) continue;
    for (const job of row.jobs) {
      if (!(REQUIRED_CONTEXTS as readonly string[]).includes(job.name)) continue;
      if (observed.has(job.name)) reject("required-context-duplicate");
      if (job.conclusion === null) reject("required-context-unresolved");
      observed.set(job.name, { context: job.name, conclusion: job.conclusion, run_id: row.run.id, completed_at: receiptInstant(row.run.updated_at) });
    }
  }
  return REQUIRED_CONTEXTS.map(name => {
    const context = observed.get(name);
    if (context === undefined) reject("required-context-unobserved");
    return context;
  });
}

export function requiredChecksReceipt(input: RequiredChecksReceiptInput) {
  return {
    schema: REQUIRED_CHECKS_PRODUCER,
    identity: {
      candidate_source_sha: digest(input.candidate_source_sha, 40),
      producer: REQUIRED_CHECKS_PRODUCER,
      producer_revision: evaluatorRevision(input.root)(REQUIRED_CHECKS_PRODUCER_FILES),
      producer_files: [...REQUIRED_CHECKS_PRODUCER_FILES],
      source_class: "exact-candidate-ci-snapshot",
      actor_class: "retained-ci-snapshot",
      attempt_id: input.attempt_id ?? randomUUID(),
      recorded_at: recordedAt(input.recorded_at ?? new Date().toISOString()),
    },
    contexts: input.contexts.map(item => ({ ...item })),
  };
}
