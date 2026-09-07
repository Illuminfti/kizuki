/** Compiled surface inventory and exact documentation bytes. This is not a
 * semantic review of prose, connector qualification, or a usability proof. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, mkdtempSync, openSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CAPABILITY_PROOF_FILE, EVALUATOR_ROOT, EVIDENCE_LIMITS, EvidenceError, SURFACE_GATE, SURFACE_OBSERVED_FILES, SURFACE_PRODUCER,
  absolute, bindEvaluatorCheckout, digest, evaluateSurfaceReceipt, expectedSurfaceInventory, hash, parents, read, reject,
} from "./release-evidence";
import type { GateReceiptReference } from "./release-evidence";

export interface CapabilityArgs { candidate: string; out: string }
export function parseCapabilityArgs(args: readonly string[]): CapabilityArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--candidate", "--out"].includes(key) || !value || value.startsWith("--") || flags.has(key)) reject("invalid-arguments");
    flags.set(key, value);
  }
  if (flags.size !== 2) reject("invalid-arguments");
  return { candidate: digest(flags.get("--candidate"), 40), out: absolute(flags.get("--out")) };
}

/** Stage complete synced bytes, then publish without replacing any destination.
 * As with the evaluator, the operator retains exclusive local path custody. */
function publish(path: string, bytes: string, unchanged: () => void) {
  const checkParents = parents(path), temporary = mkdtempSync(join(dirname(path), ".kizuki-surface-publish-"));
  const pending = join(temporary, "receipt.json");
  let cleanupFailed = false;
  try {
    const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    unchanged(); checkParents();
    linkSync(pending, path);
  } finally {
    try { rmSync(pending, { force: true }); } catch { cleanupFailed = true; }
    try { rmdirSync(temporary); } catch { cleanupFailed = true; }
  }
  try {
    checkParents();
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { reject("published-receipt-durability-unconfirmed"); }
  if (cleanupFailed) reject("published-receipt-cleanup-failed");
}

export function runCapabilityProof(args: CapabilityArgs): GateReceiptReference {
  const candidate = digest(args.candidate, 40), out = absolute(args.out);
  if (out === EVALUATOR_ROOT || out.startsWith(`${EVALUATOR_ROOT}/`)) reject("output-inside-checkout");
  // Inspect output ancestry before reading the candidate or staging any bytes.
  parents(out)();
  const frame = bindEvaluatorCheckout(EVALUATOR_ROOT, candidate, [...SURFACE_OBSERVED_FILES, CAPABILITY_PROOF_FILE]);
  const expected = expectedSurfaceInventory(frame);
  if (Bun.version !== expected.bun_version) reject("unsupported-bun-version");
  const receipt = {
    schema: SURFACE_PRODUCER,
    identity: {
      candidate_source_sha: candidate, producer: SURFACE_PRODUCER, producer_revision: expected.producer_revision,
      producer_files: expected.producer_files, source_class: "candidate-tree-inventory", actor_class: "automated-producer",
      attempt_id: randomUUID(), recorded_at: new Date().toISOString(),
    },
    outcome: "pass", failures: [], head_sha: expected.head_sha, bun_version: expected.bun_version,
    cli_verbs: expected.cli_verbs, retired_verbs: expected.retired_verbs, mcp_tools: expected.mcp_tools,
    connectors_registered: expected.connectors_registered, connectors_c3: expected.connectors_c3, docs: expected.docs,
    disagreements: [],
  };
  frame.unchanged();
  if (evaluateSurfaceReceipt(receipt, expected).status !== "PASS") reject("surface-proof-disagreement");
  const bytes = JSON.stringify(receipt, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > EVIDENCE_LIMITS.family_receipt) reject("receipt-byte-bound");
  publish(out, bytes, frame.unchanged);
  try {
    frame.unchanged();
    const published = read(out, EVIDENCE_LIMITS.family_receipt);
    if (published.sha256 !== hash(bytes)) reject("file-changed");
    published.unchanged();
    return { producer: SURFACE_PRODUCER, gate_id: SURFACE_GATE, target: null, path: out, sha256: published.sha256 };
  } catch { reject("published-receipt-verification-failed"); }
}

if (import.meta.main) {
  try { process.stdout.write(JSON.stringify(runCapabilityProof(parseCapabilityArgs(Bun.argv.slice(2)))) + "\n"); }
  catch (error) {
    const reason = error instanceof EvidenceError ? error.reason : "surface-proof-failed";
    process.stderr.write(reason.startsWith("published-receipt-")
      ? `${reason}: output was published; retain it for inspection and do not retry that path\n`
      : `${reason}: no surface receipt credited\n`);
    process.exitCode = 2;
  }
}
