import { expect, test } from "bun:test";
import {
  CONNECTORS, CONNECTOR_PRODUCER_FILES, EVALUATOR_ROOT, EvidenceError, consumeConnectorReceipt, producerEntrypointLanded,
} from "./release-evidence";
import {
  ConnectorEvidenceError, LIVE_ACCOUNT_REFUSAL, REQUIRED_EVIDENCE_STEPS,
  buildConnectorEvidenceReceipt, connectorEvidenceEntry, connectorProducerRevision, writeConnectorEvidence,
} from "./connector-evidence";
import type { EvidenceClass } from "./connector-evidence";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATE = "a".repeat(40);
const REVISION = connectorProducerRevision(EVALUATOR_ROOT);
const WITNESSABLE = CONNECTORS.filter(entry => entry.evidence !== "live-account");
/** The verdict a well-formed connector receipt reaches today. The evaluator
 * cannot separate an executed receipt from an authored one, so it credits
 * neither; see docs/release-acceptance.md. */
const TERMINAL = { status: "UNVERIFIABLE", reason: "connector-producer-not-landed", creditDigest: false } as const;
const LIVE = CONNECTORS.filter(entry => entry.evidence === "live-account");

function step(id: string, patch: Record<string, unknown> = {}) {
  return { id, command: ["kizuki", id, "--vault", "/tmp/synthetic-vault"], exit_code: 0, passed: true, stdout_sha256: "0".repeat(64), stderr_sha256: "1".repeat(64), ...patch };
}
function receiptFor(connector_id: string, evidence: EvidenceClass, patch: Record<string, unknown> = {}) {
  return buildConnectorEvidenceReceipt({
    connector_id, candidate_source_sha: CANDIDATE, producer_revision: REVISION, acceptance_credit: true,
    steps: REQUIRED_EVIDENCE_STEPS[evidence].map(id => step(id)), ...patch,
  });
}
function reasonOf(run: () => unknown): string {
  try { run(); throw new Error("expected throw"); }
  catch (error) {
    expect(error).toBeInstanceOf(EvidenceError);
    return (error as EvidenceError).reason;
  }
}
function refusalOf(run: () => unknown): string {
  try { run(); throw new Error("expected refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(ConnectorEvidenceError);
    return (error as ConnectorEvidenceError).reason;
  }
}

test("the catalogue offers exactly nine connectors this repository can witness", () => {
  expect(WITNESSABLE.map(entry => entry.id).sort()).toEqual([
    "chatgpt-export", "claude-export", "ics", "markdown-folder", "omnivore",
    "pocket", "screenpipe", "whatsapp-export", "x-archive",
  ]);
  expect(WITNESSABLE.filter(entry => entry.evidence === "local-source").map(entry => entry.id)).toEqual(["screenpipe"]);
  expect(LIVE.map(entry => entry.id).sort()).toEqual(["gmail", "google-calendar", "imap", "telegram", "whoop", "x-api"]);
});

test("every witnessable connector's receipt survives every denial for its own gate", () => {
  for (const entry of WITNESSABLE) {
    const receipt = receiptFor(entry.connector_id, entry.evidence as EvidenceClass);
    expect(receipt.connector_id).toBe(entry.id);
    expect(receipt.evidence_class).toBe(entry.evidence);
    expect(consumeConnectorReceipt(receipt, EVALUATOR_ROOT, CANDIDATE, `connector.${entry.id}`)).toEqual(TERMINAL);
  }
});

test("a hand-authored receipt cannot buy connector acceptance credit", () => {
  // The producer refuses a receipt that skips the consent arc, but that rule
  // lives in the producer and the evaluator never consults it. The evaluator's
  // own defence is the pinned producer list: while it names the evaluator module
  // alone, the revision is recomputable by anyone holding the checkout, so the
  // terminal verdict is UNVERIFIABLE and no receipt, executed or authored,
  // moves a connector gate to PASS. Extending that list is what grants credit,
  // so this assertion guards the flip, not the file list for its own sake.
  expect([...CONNECTOR_PRODUCER_FILES]).toEqual(["scripts/release-evidence.ts"]);
  expect(producerEntrypointLanded(CONNECTOR_PRODUCER_FILES)).toBe(false);
  const executed = receiptFor("kizuki.ics", "file-import");
  const forged = { ...executed, steps: [step("i-never-ran")] };
  for (const receipt of [executed, forged]) {
    const verdict = consumeConnectorReceipt(receipt, EVALUATOR_ROOT, CANDIDATE, "connector.ics");
    expect(verdict).toEqual(TERMINAL);
    expect(verdict.status).not.toBe("PASS");
  }
});

test("a live-account connector id is refused by the producer, not quietly relabelled", () => {
  for (const entry of LIVE) {
    const reason = refusalOf(() => connectorEvidenceEntry(entry.connector_id));
    expect(reason).toBe(`${LIVE_ACCOUNT_REFUSAL}:${entry.id}`);
    expect(reason).toContain("cannot stand in for a live account");
    expect(refusalOf(() => receiptFor(entry.connector_id, "file-import"))).toBe(reason);
    expect(refusalOf(() => receiptFor(entry.id, "local-source"))).toBe(reason);
  }
  expect(refusalOf(() => connectorEvidenceEntry("kizuki.beeper"))).toBe("unknown-connector:kizuki.beeper");
});

test("a receipt bound to another candidate or another producer revision is rejected", () => {
  const receipt = receiptFor("kizuki.ics", "file-import");
  expect(reasonOf(() => consumeConnectorReceipt(receipt, EVALUATOR_ROOT, "b".repeat(40), "connector.ics"))).toBe("candidate-mismatch");
  const drifted = { ...receipt, identity: { ...receipt.identity, producer_revision: "c".repeat(64) } };
  expect(reasonOf(() => consumeConnectorReceipt(drifted, EVALUATOR_ROOT, CANDIDATE, "connector.ics"))).toBe("producer-revision-mismatch");
  expect(reasonOf(() => consumeConnectorReceipt(receipt, EVALUATOR_ROOT, CANDIDATE, "connector.pocket"))).toBe("mismatched-gate-or-target");
  expect(refusalOf(() => buildConnectorEvidenceReceipt({
    connector_id: "kizuki.ics", candidate_source_sha: "unavailable", producer_revision: REVISION,
    acceptance_credit: true, steps: [step("import")],
  }))).toBe("candidate-source-sha-unavailable");
});

test("a partially failed format withholds credit and consumes to FAIL, never a skip", () => {
  const steps = REQUIRED_EVIDENCE_STEPS["file-import"].map(id => step(id, id === "repeat-import" ? { passed: false, exit_code: 1 } : {}));
  const withheld = buildConnectorEvidenceReceipt({
    connector_id: "kizuki.import-pocket", candidate_source_sha: CANDIDATE, producer_revision: REVISION,
    acceptance_credit: false, steps,
  });
  expect(withheld.acceptance_credit).toBe(false);
  expect(reasonOf(() => consumeConnectorReceipt(withheld, EVALUATOR_ROOT, CANDIDATE, "connector.pocket"))).toBe("acceptance-credit-withheld");
  // Claiming credit over the same observations is refused by the producer.
  expect(refusalOf(() => buildConnectorEvidenceReceipt({
    connector_id: "kizuki.import-pocket", candidate_source_sha: CANDIDATE, producer_revision: REVISION,
    acceptance_credit: true, steps,
  }))).toBe("acceptance-credit-claimed-for-failed-step:repeat-import");
});

test("acceptance credit needs the whole consent arc, not just a successful read", () => {
  for (const evidence of ["file-import", "local-source"] as const) {
    for (const omitted of ["revoke", "resume-revocation", "purge-status"]) {
      const steps = REQUIRED_EVIDENCE_STEPS[evidence].filter(id => id !== omitted).map(id => step(id));
      expect(refusalOf(() => buildConnectorEvidenceReceipt({
        connector_id: evidence === "file-import" ? "kizuki.ics" : "kizuki.screenpipe",
        candidate_source_sha: CANDIDATE, producer_revision: REVISION, acceptance_credit: true, steps,
      }))).toBe(`missing-required-step:${omitted}`);
    }
  }
});

test("a step the harness never ran cannot enter a receipt", () => {
  for (const [patch, reason] of [
    [{ exit_code: -1 }, "step-exit-code-unobserved:import"],
    [{ command: [] }, "invalid-step-command:import"],
    [{ stdout_sha256: "short" }, "invalid-step-digest:import"],
  ] as const) {
    expect(refusalOf(() => buildConnectorEvidenceReceipt({
      connector_id: "kizuki.ics", candidate_source_sha: CANDIDATE, producer_revision: REVISION,
      acceptance_credit: false, steps: [step("import", patch)],
    }))).toBe(reason);
  }
  expect(refusalOf(() => buildConnectorEvidenceReceipt({
    connector_id: "kizuki.ics", candidate_source_sha: CANDIDATE, producer_revision: REVISION,
    acceptance_credit: false, steps: [],
  }))).toBe("empty-step-list");
});

test("the emitted directory keeps one receipt per connector and names every blocker", () => {
  const report = mkdtempSync(join(tmpdir(), "kizuki-connector-evidence-"));
  try {
    const entries = WITNESSABLE.map(entry => ({
      receipt: receiptFor(entry.connector_id, entry.evidence as EvidenceClass),
      emission: {
        connector_id: entry.connector_id, evidence_class: entry.evidence as EvidenceClass, acceptance_credit: true,
        row_counts: { events_stored: 1 }, limits: ["synthetic limit"],
      },
    }));
    const written = writeConnectorEvidence(report, entries, ["kizuki.telegram:owner-blocked-live-account"]);
    expect(written.receipts).toHaveLength(9);
    expect(readdirSync(written.directory).sort()).toEqual([...WITNESSABLE.map(entry => `${entry.id}.json`), "index.json"].sort());
    const index = JSON.parse(readFileSync(join(written.directory, "index.json"), "utf8"));
    expect(index.schema).toBe("kizuki.connector-evidence-emission/v1");
    expect(index.unresolved).toEqual(["kizuki.telegram:owner-blocked-live-account"]);
    for (const row of written.receipts) {
      expect(consumeConnectorReceipt(JSON.parse(readFileSync(row.path, "utf8")), EVALUATOR_ROOT, CANDIDATE, `connector.${row.connector_id}`)).toEqual(TERMINAL);
    }
  } finally { rmSync(report, { recursive: true, force: true }); }
});
