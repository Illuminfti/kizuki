import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONNECTORS, CONNECTOR_PRODUCER, CONNECTOR_PRODUCER_FILES, EVALUATOR_ROOT, EvidenceError, JOURNEYS, JOURNEY_PRODUCER,
  JOURNEY_PRODUCER_FILES, P0_DISPOSITION_PRODUCER, P0_DISPOSITION_PRODUCER_FILES, P0_LABEL, RECEIPT_FAMILIES,
  REQUIRED_CHECKS_PRODUCER, REQUIRED_CHECKS_PRODUCER_FILES, REQUIRED_CONTEXTS,
  consumeConnectorReceipt, consumeJourneyReceipt, evaluateConnectorReceipt, evaluateJourneyReceipt,
  evaluateP0DispositionReceipt, evaluateRequiredChecksReceipt, evaluatorRevision, inspectOptionalVerifier, producerRevision,
} from "./release-evidence";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = "a".repeat(40);
const other = "b".repeat(40);
const recorded = "2026-09-18T00:00:00.000Z";
const later = "2026-09-18T01:00:00.000Z";
const now = Date.parse("2026-09-18T02:00:00.000Z");
/** Synthetic evaluator revision: these tests never claim a real producer checkout. */
const revision = (files: readonly string[]) => digest(JSON.stringify([...files]));
const binding = { candidate_source_sha: source, revision };
const p0Binding = { ...binding, now };

function identity(producer: string, files: readonly string[], source_class: string, actor_class: string, patch: Record<string, unknown> = {}) {
  return {
    candidate_source_sha: source, producer, producer_revision: revision(files), producer_files: [...files],
    source_class, actor_class, attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", recorded_at: recorded, ...patch,
  };
}
function reasonOf(run: () => unknown): string {
  try { run(); throw new Error("expected throw"); }
  catch (error) {
    expect(error).toBeInstanceOf(EvidenceError);
    return (error as EvidenceError).reason;
  }
}
function step(id: string, patch: Record<string, unknown> = {}) {
  return { id, command: ["kizuki", "--help"], exit_code: 0, passed: true, stdout_sha256: "0".repeat(64), stderr_sha256: "1".repeat(64), ...patch };
}
const checksIdentity = () => identity(REQUIRED_CHECKS_PRODUCER, REQUIRED_CHECKS_PRODUCER_FILES, "exact-candidate-ci-snapshot", "retained-ci-snapshot");
function checksBody(patch: Record<string, unknown> = {}) {
  return {
    schema: REQUIRED_CHECKS_PRODUCER, identity: checksIdentity(),
    contexts: REQUIRED_CONTEXTS.map((context, index) => ({ context, conclusion: "success", run_id: 100 + index, completed_at: recorded })),
    ...patch,
  };
}
const p0Identity = () => identity(P0_DISPOSITION_PRODUCER, P0_DISPOSITION_PRODUCER_FILES, "findings-snapshot", "retained-ci-snapshot");
function p0Body(patch: Record<string, unknown> = {}) {
  return {
    schema: P0_DISPOSITION_PRODUCER, identity: p0Identity(), label: P0_LABEL,
    candidate_committed_at: recorded, snapshot_at: later, open_issues: [] as unknown[], ...patch,
  };
}
const journeyIdentity = () => identity(JOURNEY_PRODUCER, JOURNEY_PRODUCER_FILES, "local-operator-custody", "authorized-operator");
function journeyBody(journey_id: string, patch: Record<string, unknown> = {}) {
  return { schema: JOURNEY_PRODUCER, identity: journeyIdentity(), journey_id, acceptance_credit: true, steps: [step("install"), step("resume")], ...patch };
}
const connectorSource = { "live-account": "live-account-operator", "file-import": "file-import-operator", "local-source": "local-source-operator" } as const;
function connectorBody(connector_id: string, evidence_class: "live-account" | "file-import" | "local-source", patch: Record<string, unknown> = {}) {
  return {
    schema: CONNECTOR_PRODUCER,
    identity: identity(CONNECTOR_PRODUCER, CONNECTOR_PRODUCER_FILES, connectorSource[evidence_class], "authorized-operator"),
    connector_id, evidence_class, acceptance_credit: true, steps: [step("enroll")], ...patch,
  };
}

test("a complete required-checks receipt for the exact candidate passes", () => {
  expect(evaluateRequiredChecksReceipt(checksBody(), binding)).toEqual({
    status: "PASS", reason: "exact-candidate-required-checks-passed", creditDigest: true,
  });
});

test("required checks are exactly test, secrets and workflows", () => {
  expect([...REQUIRED_CONTEXTS]).toEqual(["test", "secrets", "workflows"]);
  const partial = checksBody().contexts.slice(0, 2);
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ contexts: partial }), binding))).toBe("required-contexts-mismatch");
  const renamed = checksBody().contexts.map(row => row.context === "secrets" ? { ...row, context: "gitleaks" } : row);
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ contexts: renamed }), binding))).toBe("required-contexts-mismatch");
  const reordered = [...checksBody().contexts].reverse();
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ contexts: reordered }), binding))).toBe("required-contexts-mismatch");
  const duplicated = [checksBody().contexts[0]!, checksBody().contexts[0]!, checksBody().contexts[0]!];
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ contexts: duplicated }), binding))).toBe("required-contexts-mismatch");
});

test("a required context that did not conclude success cannot pass", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", "stale"]) {
    const contexts = checksBody().contexts.map(row => row.context === "test" ? { ...row, conclusion } : row);
    expect(evaluateRequiredChecksReceipt(checksBody({ contexts }), binding)).toEqual({
      status: "FAIL", reason: "required-context-not-successful", creditDigest: true,
    });
  }
  const invented = checksBody().contexts.map(row => ({ ...row, conclusion: "green" }));
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ contexts: invented }), binding))).toBe("invalid-schema");
});

test("required-checks identity binds the candidate, the producer files and their revision", () => {
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ identity: { ...checksIdentity(), candidate_source_sha: other } }), binding))).toBe("candidate-mismatch");
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ identity: { ...checksIdentity(), producer_revision: "c".repeat(64) } }), binding))).toBe("producer-revision-mismatch");
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({
    identity: { ...checksIdentity(), producer_files: ["scripts/release-evidence.ts"], producer_revision: revision(["scripts/release-evidence.ts"]) },
  }), binding))).toBe("producer-files-mismatch");
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ identity: { ...checksIdentity(), source_class: "synthetic-fixture" } }), binding))).toBe("invalid-identity");
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ identity: { ...checksIdentity(), source_class: "not-a-source-class" } }), binding))).toBe("invalid-identity");
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ identity: { ...checksIdentity(), actor_class: "authorized-operator" } }), binding))).toBe("invalid-identity");
  expect(reasonOf(() => evaluateRequiredChecksReceipt(checksBody({ schema: "kizuki.required-checks/v2" }), binding))).toBe("invalid-schema");
  expect(reasonOf(() => evaluateRequiredChecksReceipt({ ...checksBody(), status: "PASS" }, binding))).toBe("invalid-schema");
});

test("an empty open-issue inventory on the exact candidate passes p0 disposition", () => {
  expect(evaluateP0DispositionReceipt(p0Body(), p0Binding)).toEqual({
    status: "PASS", reason: "current-p0-inventory-clear", creditDigest: true,
  });
});

test("open p0 findings fail and are named in the reason", () => {
  const evaluated = evaluateP0DispositionReceipt(p0Body({
    open_issues: [{ number: 45, updated_at: later }, { number: 12, updated_at: recorded }],
  }), p0Binding);
  expect(evaluated).toEqual({ status: "FAIL", reason: "current-p0-findings-open:12,45", creditDigest: true });
});

test("a p0 snapshot that predates the candidate or postdates the evaluation cannot certify", () => {
  expect(evaluateP0DispositionReceipt(p0Body({ candidate_committed_at: later, snapshot_at: recorded }), p0Binding)).toEqual({
    status: "UNVERIFIABLE", reason: "p0-snapshot-predates-candidate", creditDigest: false,
  });
  expect(evaluateP0DispositionReceipt(p0Body({ snapshot_at: "2026-09-19T00:00:00.000Z" }), p0Binding)).toEqual({
    status: "UNVERIFIABLE", reason: "p0-snapshot-after-evaluation", creditDigest: false,
  });
});

test("p0 disposition binds its label, identity and inventory shape", () => {
  expect(reasonOf(() => evaluateP0DispositionReceipt(p0Body({ label: "severity:p1" }), p0Binding))).toBe("p0-label-mismatch");
  expect(reasonOf(() => evaluateP0DispositionReceipt(p0Body({ identity: { ...p0Identity(), candidate_source_sha: other } }), p0Binding))).toBe("candidate-mismatch");
  expect(reasonOf(() => evaluateP0DispositionReceipt(p0Body({ identity: { ...p0Identity(), producer_revision: "c".repeat(64) } }), p0Binding))).toBe("producer-revision-mismatch");
  expect(reasonOf(() => evaluateP0DispositionReceipt(p0Body({ open_issues: [{ number: 12, updated_at: recorded }, { number: 12, updated_at: later }] }), p0Binding))).toBe("invalid-schema");
  expect(reasonOf(() => evaluateP0DispositionReceipt(p0Body({ open_issues: [{ number: 0, updated_at: recorded }] }), p0Binding))).toBe("invalid-schema");
  expect(reasonOf(() => evaluateP0DispositionReceipt(p0Body({ snapshot_at: "2026-09-18T01:00:00Z" }), p0Binding))).toBe("invalid-recorded-at");
});

test("a complete journey receipt passes only its own gate", () => {
  expect(evaluateJourneyReceipt(journeyBody("connect-resume"), { ...binding, journey_id: "connect-resume" })).toEqual({
    status: "PASS", reason: "journey-steps-passed", creditDigest: true,
  });
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("correct-belief"), { ...binding, journey_id: "connect-resume" }))).toBe("mismatched-gate-or-target");
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("connect-and-resume"), { ...binding, journey_id: "connect-and-resume" }))).toBe("unknown-journey");
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("connect-resume", {
    identity: { ...journeyIdentity(), candidate_source_sha: other },
  }), { ...binding, journey_id: "connect-resume" }))).toBe("candidate-mismatch");
});

test("every journey id is consumable and none is special-cased", () => {
  for (const journey of JOURNEYS) {
    expect(evaluateJourneyReceipt(journeyBody(journey), { ...binding, journey_id: journey })).toMatchObject({ status: "PASS" });
  }
});

test("a journey receipt without passing steps or acceptance credit is refused", () => {
  const gate = { ...binding, journey_id: "daily-loop" };
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("daily-loop", { steps: [] }), gate))).toBe("empty-step-list");
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("daily-loop", { steps: [step("one"), step("two", { passed: false, exit_code: 1 })] }), gate))).toBe("step-not-passed");
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("daily-loop", { acceptance_credit: false }), gate))).toBe("acceptance-credit-withheld");
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("daily-loop", { steps: [step("one"), step("one")] }), gate))).toBe("invalid-schema");
});

test("a receipt carrying raw command output instead of a digest is refused", () => {
  const gate = { ...binding, journey_id: "useful-insight" };
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("useful-insight", {
    steps: [{ ...step("one"), stdout: "synthetic captured output" }],
  }), gate))).toBe("receipt-carries-raw-output");
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("useful-insight", {
    steps: [{ ...step("one"), stderr: "synthetic captured output" }],
  }), gate))).toBe("receipt-carries-raw-output");
  expect(reasonOf(() => evaluateJourneyReceipt({ ...journeyBody("useful-insight"), stdout: "synthetic captured output" }, gate))).toBe("receipt-carries-raw-output");
});

test("a file-import connector receipt can never satisfy a live-account gate", () => {
  for (const id of ["telegram", "gmail", "google-calendar", "imap", "whoop", "x-api"]) {
    const entry = CONNECTORS.find(item => item.id === id)!;
    expect(entry.evidence).toBe("live-account");
    expect(reasonOf(() => evaluateConnectorReceipt(connectorBody(id, "file-import"), { ...binding, connector_id: id }))).toBe("connector-evidence-class-mismatch");
    expect(reasonOf(() => evaluateConnectorReceipt(connectorBody(id, "local-source"), { ...binding, connector_id: id }))).toBe("connector-evidence-class-mismatch");
    expect(reasonOf(() => evaluateConnectorReceipt(connectorBody("x-archive", "file-import"), { ...binding, connector_id: id }))).toBe("mismatched-gate-or-target");
  }
});

test("each connector receipt needs the operator class its evidence family requires", () => {
  for (const entry of CONNECTORS) {
    const gate = { ...binding, connector_id: entry.id };
    expect(evaluateConnectorReceipt(connectorBody(entry.id, entry.evidence), gate)).toEqual({
      status: "PASS", reason: "connector-steps-passed", creditDigest: true,
    });
    const wrongActor = connectorBody(entry.id, entry.evidence, {
      identity: identity(CONNECTOR_PRODUCER, ["scripts/release-evidence.ts"], "synthetic-fixture", "authorized-operator"),
    });
    expect(reasonOf(() => evaluateConnectorReceipt(wrongActor, gate))).toBe("invalid-identity");
  }
  expect(reasonOf(() => evaluateConnectorReceipt(connectorBody("beeper", "live-account"), { ...binding, connector_id: "beeper" }))).toBe("unknown-connector");
});

test("the evaluator revision is the evaluator's own producer bytes", () => {
  const resolved = evaluatorRevision(EVALUATOR_ROOT);
  expect(resolved(REQUIRED_CHECKS_PRODUCER_FILES)).toBe(producerRevision(REQUIRED_CHECKS_PRODUCER_FILES.map(path => ({
    path, sha256: digest(readFileSync(join(EVALUATOR_ROOT, path))),
  }))));
  expect(resolved(P0_DISPOSITION_PRODUCER_FILES)).not.toBe(resolved(REQUIRED_CHECKS_PRODUCER_FILES));
  expect(reasonOf(() => resolved(["scripts/absent-producer.ts"]))).toBe("producer-files-unavailable");
});

test("consuming a receipt against the evaluator checkout refuses a foreign producer revision", () => {
  expect(reasonOf(() => consumeJourneyReceipt(journeyBody("connect-resume"), EVALUATOR_ROOT, source, "journey.connect-resume"))).toBe("producer-revision-mismatch");
  expect(reasonOf(() => consumeConnectorReceipt(connectorBody("ics", "file-import"), EVALUATOR_ROOT, source, "connector.ics"))).toBe("producer-revision-mismatch");
  expect(reasonOf(() => consumeJourneyReceipt(journeyBody("connect-resume"), EVALUATOR_ROOT, source, "connector.connect-resume"))).toBe("mismatched-gate-or-target");
});

test("the consumable family registry covers exactly the four wired producers", () => {
  expect(Object.keys(RECEIPT_FAMILIES).sort()).toEqual([
    CONNECTOR_PRODUCER, JOURNEY_PRODUCER, P0_DISPOSITION_PRODUCER, REQUIRED_CHECKS_PRODUCER,
  ].sort());
});

test("journey and connector receipts cannot choose which producer files bind them", () => {
  // A self-consistent revision over a file the family never produces is still refused.
  const forged = ["package.json"];
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("connect-resume", {
    identity: identity(JOURNEY_PRODUCER, forged, "local-operator-custody", "authorized-operator"),
  }), { ...binding, journey_id: "connect-resume" }))).toBe("producer-files-mismatch");
  expect(reasonOf(() => evaluateConnectorReceipt(connectorBody("telegram", "live-account", {
    identity: identity(CONNECTOR_PRODUCER, forged, "live-account-operator", "authorized-operator"),
  }), { ...binding, connector_id: "telegram" }))).toBe("producer-files-mismatch");
  expect([...JOURNEY_PRODUCER_FILES]).toEqual(["scripts/release-evidence.ts"]);
  expect([...CONNECTOR_PRODUCER_FILES]).toEqual(["scripts/release-evidence.ts"]);
});

test("a receipt cannot steer the evaluator outside its own checkout", () => {
  const traversal = ["../../../../etc/passwd"];
  for (const family of [
    () => evaluateJourneyReceipt(journeyBody("connect-resume", {
      identity: identity(JOURNEY_PRODUCER, traversal, "local-operator-custody", "authorized-operator"),
    }), { ...binding, journey_id: "connect-resume" }),
    () => evaluateConnectorReceipt(connectorBody("telegram", "live-account", {
      identity: identity(CONNECTOR_PRODUCER, traversal, "live-account-operator", "authorized-operator"),
    }), { ...binding, connector_id: "telegram" }),
    () => evaluateRequiredChecksReceipt(checksBody({
      identity: { ...checksIdentity(), producer_files: traversal, producer_revision: revision(traversal) },
    }), binding),
  ]) expect(reasonOf(family)).toBe("invalid-identity");
  // The path segments `.` and `..` are rejected before any filesystem access, and
  // the reader itself refuses a resolved path outside the checkout.
  expect(reasonOf(() => inspectOptionalVerifier(EVALUATOR_ROOT, "../../../../etc/passwd"))).toBe("verifier-file-outside-checkout");
  expect(reasonOf(() => inspectOptionalVerifier(EVALUATOR_ROOT, "scripts/../../etc/passwd"))).toBe("verifier-file-outside-checkout");
  expect(reasonOf(() => evaluatorRevision(EVALUATOR_ROOT)(["../../../../etc/definitely-missing"]))).toBe("verifier-file-outside-checkout");
});

test("the journey and connector families bind the evaluator's real checkout bytes", () => {
  const bind = evaluatorRevision(EVALUATOR_ROOT);
  const real = (producer: string, files: readonly string[], source_class: string) =>
    identity(producer, files, source_class, "authorized-operator", { producer_revision: bind(files) });
  expect(evaluateJourneyReceipt(journeyBody("connect-resume", {
    identity: real(JOURNEY_PRODUCER, JOURNEY_PRODUCER_FILES, "local-operator-custody"),
  }), { candidate_source_sha: source, revision: bind, journey_id: "connect-resume" })).toEqual({
    status: "PASS", reason: "journey-steps-passed", creditDigest: true,
  });
  expect(reasonOf(() => evaluateJourneyReceipt(journeyBody("connect-resume", {
    identity: identity(JOURNEY_PRODUCER, JOURNEY_PRODUCER_FILES, "local-operator-custody", "authorized-operator"),
  }), { candidate_source_sha: source, revision: bind, journey_id: "connect-resume" }))).toBe("producer-revision-mismatch");
});
