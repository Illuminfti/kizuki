/**
 * Shared `kizuki.connector-evidence/v1` producer.
 *
 * The file-import and local-source proofs observe a compiled artifact through
 * the public CLI; this module turns those observations into the receipt the
 * offline acceptance evaluator consumes. It never decides a verdict: it fixes
 * the evidence class from the frozen C3 catalogue, refuses to speak for a
 * connector whose obligation is a live account, and withholds acceptance credit
 * whenever a step did not pass.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONNECTORS, CONNECTOR_PRODUCER, CONNECTOR_PRODUCER_FILES, CONNECTOR_SOURCE_CLASSES, evaluatorRevision,
} from "./release-evidence";

export class ConnectorEvidenceError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function refuse(reason: string): never { throw new ConnectorEvidenceError(reason); }

export type EvidenceClass = "file-import" | "local-source";
export type CatalogueEntry = typeof CONNECTORS[number];

/**
 * A promoted receipt must show the whole consent arc, not just a successful
 * read: capture, idempotent repeat, revoke, the refusal that follows it, and
 * physical purge with its receipted status. A producer that skips one of these
 * cannot claim acceptance credit for the connector.
 */
export const REQUIRED_EVIDENCE_STEPS: Readonly<Record<EvidenceClass, readonly string[]>> = Object.freeze({
  "file-import": Object.freeze([
    "import", "query", "status", "repeat-import", "repeat-query", "repeat-status",
    "revoke", "revoked-query", "resume-revocation", "purged-query", "purge-status", "denied-reimport",
  ]),
  "local-source": Object.freeze([
    "connect", "grant", "backfill", "query", "sync", "repeat-query", "status",
    "revoke", "revoked-query", "resume-revocation", "purged-query", "purge-status", "denied-backfill",
  ]),
});

export const LIVE_ACCOUNT_REFUSAL =
  "live-account-obligation-not-witnessable: a file import or a local database read cannot stand in for a live account";

export interface ConnectorEvidenceStep {
  id: string; command: readonly string[]; exit_code: number; passed: boolean;
  stdout_sha256: string; stderr_sha256: string;
}
export interface ConnectorEvidenceInput {
  /** Registry id as the frozen catalogue records it, for example `kizuki.ics`. */
  connector_id: string;
  candidate_source_sha: string;
  steps: readonly ConnectorEvidenceStep[];
  acceptance_credit: boolean;
  producer_revision: string;
  recorded_at?: string;
  attempt_id?: string;
}
export interface ConnectorEvidenceReceipt {
  schema: typeof CONNECTOR_PRODUCER;
  identity: {
    candidate_source_sha: string; producer: string; producer_revision: string; producer_files: string[];
    source_class: string; actor_class: string; attempt_id: string; recorded_at: string;
  };
  connector_id: string;
  evidence_class: EvidenceClass;
  acceptance_credit: boolean;
  steps: ConnectorEvidenceStep[];
}

/** The catalogue row a producer may speak for, or a refusal naming why it may not. */
export function connectorEvidenceEntry(connectorId: string): CatalogueEntry {
  const entry = CONNECTORS.find(item => item.connector_id === connectorId) ??
    CONNECTORS.find(item => item.id === connectorId);
  if (!entry) refuse(`unknown-connector:${connectorId}`);
  if (entry.evidence === "live-account") refuse(`${LIVE_ACCOUNT_REFUSAL}:${entry.id}`);
  return entry;
}

/** The evaluator's own revision over this family's pinned producer files. */
export function connectorProducerRevision(root: string): string {
  return evaluatorRevision(root)(CONNECTOR_PRODUCER_FILES);
}

function checkSteps(steps: readonly ConnectorEvidenceStep[], evidence: EvidenceClass, credit: boolean): ConnectorEvidenceStep[] {
  if (steps.length === 0) refuse("empty-step-list");
  const ids = steps.map(step => step.id);
  if (new Set(ids).size !== ids.length) refuse("duplicate-step-id");
  for (const step of steps) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.id)) refuse(`invalid-step-id:${step.id}`);
    if (!Number.isSafeInteger(step.exit_code) || step.exit_code < 0 || step.exit_code > 255) refuse(`step-exit-code-unobserved:${step.id}`);
    if (step.command.length < 1 || step.command.length > 16) refuse(`invalid-step-command:${step.id}`);
    for (const word of step.command) if (word.length < 1 || word.length > 512 || /[\x00-\x1f\x7f]/.test(word)) refuse(`invalid-step-command:${step.id}`);
    for (const value of [step.stdout_sha256, step.stderr_sha256]) if (!/^[a-f0-9]{64}$/.test(value)) refuse(`invalid-step-digest:${step.id}`);
  }
  if (credit) {
    const failed = steps.filter(step => !step.passed).map(step => step.id);
    if (failed.length > 0) refuse(`acceptance-credit-claimed-for-failed-step:${failed.join(",")}`);
    const missing = REQUIRED_EVIDENCE_STEPS[evidence].filter(id => !ids.includes(id));
    if (missing.length > 0) refuse(`missing-required-step:${missing.join(",")}`);
  }
  return steps.map(step => ({ ...step, command: [...step.command] }));
}

export function buildConnectorEvidenceReceipt(input: ConnectorEvidenceInput): ConnectorEvidenceReceipt {
  const entry = connectorEvidenceEntry(input.connector_id);
  const evidence = entry.evidence as EvidenceClass;
  if (!/^[a-f0-9]{40}$/.test(input.candidate_source_sha)) refuse("candidate-source-sha-unavailable");
  if (!/^[a-f0-9]{64}$/.test(input.producer_revision)) refuse("producer-revision-unavailable");
  const recorded_at = input.recorded_at ?? new Date().toISOString();
  const attempt_id = input.attempt_id ?? randomUUID();
  return {
    schema: CONNECTOR_PRODUCER,
    identity: {
      candidate_source_sha: input.candidate_source_sha,
      producer: CONNECTOR_PRODUCER,
      producer_revision: input.producer_revision,
      producer_files: [...CONNECTOR_PRODUCER_FILES],
      source_class: CONNECTOR_SOURCE_CLASSES[evidence],
      actor_class: "authorized-operator",
      attempt_id,
      recorded_at,
    },
    connector_id: entry.id,
    evidence_class: evidence,
    acceptance_credit: input.acceptance_credit,
    steps: checkSteps(input.steps, evidence, input.acceptance_credit),
  };
}

export interface ConnectorEvidenceEmission {
  /** Observations the evaluator's exact receipt schema has no field for. */
  connector_id: string; evidence_class: EvidenceClass; acceptance_credit: boolean;
  row_counts: Record<string, number>; limits: readonly string[];
}
export interface ConnectorEvidenceReport {
  directory: string; receipts: { connector_id: string; path: string }[]; unresolved: string[];
}

/**
 * Write one receipt per connector plus a human-readable emission summary. The
 * evaluator's receipt schema is closed, so observed row counts and the
 * connector's own documented limits are recorded beside it rather than smuggled
 * into a receipt the evaluator would refuse to read.
 */
export function writeConnectorEvidence(
  reportDirectory: string,
  entries: readonly { receipt: ConnectorEvidenceReceipt; emission: ConnectorEvidenceEmission }[],
  unresolved: readonly string[],
): ConnectorEvidenceReport {
  const directory = join(reportDirectory, "connector-evidence");
  mkdirSync(directory, { mode: 0o700, recursive: false });
  const receipts = entries.map(entry => {
    const path = join(directory, `${entry.receipt.connector_id}.json`);
    writeFileSync(path, JSON.stringify(entry.receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { connector_id: entry.receipt.connector_id, path };
  });
  const summary = {
    schema: "kizuki.connector-evidence-emission/v1",
    receipt_schema: CONNECTOR_PRODUCER,
    emissions: entries.map(entry => entry.emission),
    receipts,
    unresolved: [...unresolved],
  };
  writeFileSync(join(directory, "index.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { directory, receipts, unresolved: [...unresolved] };
}
