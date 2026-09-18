import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FILE_FORMATS, FILE_IMPORT_POLICY, fileImportFixtures } from "./file-import-proof-fixtures";
import { consentObservation, expectedFileImportSteps, importCounts, importDiagnostics, parseFileImportArgs, queryObservation, statusObservation } from "./file-import-proof";

test("all eight public file formats have distinct bounded serialized fixtures and explicit local consent", () => {
  const cases = fileImportFixtures("2026-09-07");
  expect(cases.map(x => x.format)).toEqual([...FILE_FORMATS]);
  expect(new Set(cases.map(x => x.connector)).size).toBe(8);
  expect(new Set(cases.map(x => x.sentinel)).size).toBe(8);
  expect(FILE_IMPORT_POLICY.egress).toBe("local_only");
  for (const fixture of cases) {
    expect(fixture.events).toBe(1);
    expect(fixture.proposals).toBe(fixture.format === "whatsapp" ? 3 : 2);
    expect(Object.values(fixture.valid).some(text => typeof text === "string" && text.includes(fixture.sentinel))).toBe(true);
    for (const scenario of [fixture.valid, fixture.invalid]) for (const [name, bytes] of Object.entries(scenario)) {
      expect(name.startsWith("/") || name.split("/").includes("..")).toBe(false);
      expect(Buffer.byteLength(bytes)).toBeLessThan(4096);
    }
    const steps = expectedFileImportSteps(fixture);
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps).toContain("denied-reimport-query"); expect(steps).toContain("invalid-import");
  }
});
test("first-status stored matches the imported event count for ChatGPT, Claude and markdown-folder", () => {
  const cases = fileImportFixtures("2026-09-07");
  for (const format of ["chatgpt", "claude", "markdown-folder"] as const) {
    const item = cases.find(entry => entry.format === format)!;
    expect(item.last_batch_stored).toBe(item.events);
  }
});
test("file fixture timestamps are explicit and no source filename can be supplied as a runtime knob", () => {
  expect(fileImportFixtures("2026-09-07")[0]!.valid["calendar.ics"]).toContain("DTSTART:20260908T090000Z");
  expect(() => fileImportFixtures("not a date")).toThrow();
  expect(() => parseFileImportArgs(["--artifact", "/a", "--artifact-proof", "/b", "--report", "/c", "--source", "/private"])).toThrow();
  expect(() => parseFileImportArgs(["--artifact", "/a", "--artifact", "/b", "--report", "/c"])).toThrow();
});
test("exact import counts distinguish successful idempotence and partial failure", () => {
  expect(importCounts("events_stored=1 duplicates=0 proposals_created=2 withdrawn=0 retractions_filed=0 errors=0\n", 1, 0, 2).proposals).toBe(2);
  expect(() => importCounts("events_stored=1 duplicates=0 proposals_created=3 withdrawn=0 retractions_filed=0 errors=0\n", 1, 0, 2)).toThrow();
  expect(importCounts("events_stored=0 duplicates=0 proposals_created=0 withdrawn=0 retractions_filed=0 errors=0\n", 0, 0).stored).toBe(0);
  expect(importCounts("events_stored=0 duplicates=1 proposals_created=0 withdrawn=0 retractions_filed=0 errors=0\n", 0, 0, 0, 1).duplicates).toBe(1);
  expect(importCounts("events_stored=1 duplicates=0 proposals_created=0 withdrawn=0 retractions_filed=0 errors=1\n", 1, 1).errors).toBe(1);
  for (const raw of ["events_stored=1 duplicates=1 proposals_created=0 withdrawn=0 retractions_filed=0 errors=0\n", "events_stored=0 duplicates=0 proposals_created=0 withdrawn=0 retractions_filed=0 errors=0\n", "events_stored=1 duplicates=0 proposals_created=0 withdrawn=0 retractions_filed=0 errors=0\nextra\n"]) expect(() => importCounts(raw, 1, 0)).toThrow();
});
const fixture = { connector: "kizuki.markdown-folder", sentinel: "markdownotter" };
function result() {
  return { schema: "kizuki.cli.query/v1", status: "ok", data: { hits: [{ doc_id: "event:synthetic", scope: "ledger", title: "synthetic", path: "", page_type: "note", sensitivity: "private", taint: "quoted", authority: "connector_evidence", occurred_at: "2026-01-01T00:00:00Z", connector_id: fixture.connector, subjects: [], snippet: fixture.sentinel, rank: 0 }], withheld: 0 }, degraded: [], warnings: [] };
}
test("public query oracle binds exact cardinality, source, private evidence and sentinel", () => {
  expect(queryObservation(JSON.stringify(result()), "", fixture, 1).hit_ids).toEqual(["event:synthetic"]);
  const absent = result(); absent.data.hits = [];
  expect(queryObservation(JSON.stringify(absent), "", fixture, 0).hit_ids).toEqual([]);
});
for (const [name, mutate] of [
  ["extra hit", (r: any) => r.data.hits.push(structuredClone(r.data.hits[0]))],
  ["different connector", (r: any) => r.data.hits[0].connector_id = "kizuki.other"],
  ["missing sentinel", (r: any) => r.data.hits[0].snippet = "different"],
  ["weaker sensitivity", (r: any) => r.data.hits[0].sensitivity = "public"],
  ["invented authority", (r: any) => r.data.hits[0].authority = "owner_statement"],
  ["contradictory status", (r: any) => r.status = "degraded"],
  ["unexpected field", (r: any) => r.data.approved = true],
] as const) test(`query oracle refuses ${name}`, () => {
  const actual = result(); mutate(actual); expect(() => queryObservation(JSON.stringify(actual), "", fixture, 1)).toThrow();
});
test("query cannot hide extra stdout, diagnostics or duplicate JSON keys", () => {
  const raw = JSON.stringify(result());
  expect(() => queryObservation(raw + "\nextra", "", fixture, 1)).toThrow();
  expect(() => queryObservation(raw, "unexpected\n", fixture, 1)).toThrow();
  expect(() => queryObservation('{"schema":"kizuki.cli.query/v1",' + raw.slice(1), "", fixture, 1)).toThrow();
});


test("public consent oracle preserves the original policy and source-bound receipt", () => {
  const source = "01JJ0000000000000000000001", connector = "kizuki.ics", operation = "synthetic-revoke";
  const policy = { ...FILE_IMPORT_POLICY, purposes: [...FILE_IMPORT_POLICY.purposes].sort(), allowed_fields: [...FILE_IMPORT_POLICY.allowed_fields].sort() };
  const digest = createHash("sha256").update(JSON.stringify(policy)).digest("hex"), at = "2026-09-07T00:00:00Z";
  const result = { schema: "kizuki.cli.connect/v1", status: "ok", degraded: [], warnings: [], data: {
    source_key: source, purge: "pending", maintenance_error: null,
    grant: { source_key: source, connector_id: connector, revision: 2, status: "denied", policy, policy_digest: digest, updated_at: at, revoke_operation: operation, purge_receipt_id: "01JJ0000000000000000000002", erasure: null,
      retention_effects: { joint_derived_records: "whole_record_erasure", disposable_retrieval: "whole_generation_erasure" }, owned_retrieval: [], purge_blockers: [] },
    receipt: { operation_id: operation, source_key: source, action: "revoke", prior_revision: 1, revision: 2, status: "denied", at, policy_digest: digest },
  } };
  expect(consentObservation(JSON.stringify(result), source, "denied", connector, operation).consent).toBe("denied");
  for (const mutate of [
    (value: any) => value.data.grant.policy.purposes.push("extract"),
    (value: any) => value.data.grant.source_key = "01JJ0000000000000000000009",
    (value: any) => value.data.receipt.action = "grant",
    (value: any) => value.data.grant.approved = true,
  ]) { const invalid = structuredClone(result); mutate(invalid); expect(() => consentObservation(JSON.stringify(invalid), source, "denied", connector, operation)).toThrow(); }
});


test("positive query refuses a self-consistent unavailable retrieval fallback", () => {
  const degraded = result(); degraded.status = "degraded"; (degraded.degraded as string[]).push("retrieval-unavailable");
  expect(() => queryObservation(JSON.stringify(degraded), "degraded=retrieval-unavailable\n", fixture, 1)).toThrow();
});

test("ordinary empty query refuses unavailable or unexpectedly stale retrieval", () => {
  for (const code of ["retrieval-unavailable", "index-behind-ledger"]) {
    const degraded = result(); degraded.status = "degraded"; degraded.data.hits = []; (degraded.degraded as string[]).push(code);
    expect(() => queryObservation(JSON.stringify(degraded), `degraded=${code}\n`, fixture, 0)).toThrow();
  }
});


test("only post-purge absence may carry the documented index-count lag", () => {
  const negative = result(); negative.status = "degraded"; negative.data.hits = []; (negative.degraded as string[]).push("index-behind-ledger");
  expect(queryObservation(JSON.stringify(negative), "degraded=index-behind-ledger\n", fixture, 0, "post_purge").degraded).toEqual(["index-behind-ledger"]);
  for (const flags of [["retrieval-unavailable"], ["index-behind-ledger", "retrieval-unavailable"], ["index-behind-ledger", "index-behind-ledger"]]) {
    const invalid = structuredClone(negative); (invalid.degraded as string[]) = flags;
    expect(() => queryObservation(JSON.stringify(invalid), `degraded=${flags.join(",")}\n`, fixture, 0, "post_purge")).toThrow();
  }
  const positive = result(); positive.status = "degraded"; (positive.degraded as string[]).push("index-behind-ledger");
  expect(() => queryObservation(JSON.stringify(positive), "degraded=index-behind-ledger\n", fixture, 1, "post_purge")).toThrow();
});


test("failed import rejects extra errors and another format's health notice", () => {
  const error = "error: partial_import: 1 record errors (not_utf8=1)\n";
  const notice = "degraded: Claude health check before capture found partial or unsupported content.\n";
  expect(() => importDiagnostics(error + "error: synthetic unexpected extra failure\n", 1, "not_utf8", "kizuki.markdown-folder")).toThrow();
  expect(() => importDiagnostics(notice + error, 1, "not_utf8", "kizuki.markdown-folder")).toThrow();
  expect(() => importDiagnostics(error + "\n", 1, "not_utf8", "kizuki.markdown-folder")).toThrow();
});


test("failed import keeps its one qualified error and optional Claude notice", () => {
  expect(() => importDiagnostics("error: partial_import: 1 record errors (not_utf8=1)\n", 1, "not_utf8", "kizuki.markdown-folder")).not.toThrow();
  expect(() => importDiagnostics("degraded: Claude health check before capture found partial or unsupported content.\nerror: partial_import: 1 record errors (not_object=1)\n", 1, "not_object", "kizuki.import-claude")).not.toThrow();
});

test("a zero-event initial failure requires the exact enrollment cleanup diagnostic", () => {
  const cleanup = "error: initial backfill stored no usable events; connection was not left active\n";
  const error = "error: partial_import: 1 record errors (not_utf8=1)\n";
  expect(() => importDiagnostics(cleanup + error, 1, "not_utf8", "kizuki.markdown-folder", true)).not.toThrow();
  for (const invalid of [
    error,
    "error: initial backfill failed; connection removed\n" + error,
    cleanup + error + "error: unexpected\n",
  ]) {
    expect(() => importDiagnostics(invalid, 1, "not_utf8", "kizuki.markdown-folder", true)).toThrow();
  }
});

test("status distinguishes disconnected zero-event failure from enrolled partial import", () => {
  const source = "01JJ0000000000000000000001";
  const body = (state: "enrolled" | "disconnected", stored: number) => JSON.stringify({
    schema: "kizuki.cli.connect/v1", status: "ok", degraded: [], warnings: [],
    data: { connections: [{ connector_id: "kizuki.markdown-folder", source_key: source, state, consent: "active", revision: 1,
      purge_blockers: [], sensitivity: "private", last_run: "2026-09-15T00:00:00Z", stored, errors: 1 }] },
  });
  expect(statusObservation(body("enrolled", 1), "kizuki.markdown-folder", source, 1, 1).sourceKey).toBe(source);
  expect(statusObservation(body("disconnected", 0), "kizuki.markdown-folder", source, 0, 1, 1, "disconnected").sourceKey).toBe(source);
  expect(() => statusObservation(body("enrolled", 0), "kizuki.markdown-folder", source, 0, 1, 1, "disconnected")).toThrow();
});


import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVALUATOR_ROOT, EvidenceError, consumeConnectorReceipt } from "./release-evidence";
import { connectorProducerRevision, REQUIRED_EVIDENCE_STEPS } from "./connector-evidence";
import { FILE_IMPORT_SHARED_LIMIT, fileImportLimits } from "./file-import-proof-fixtures";
import { emitFileImportConnectorEvidence } from "./file-import-proof";
import type { CaseReceipt } from "./file-import-proof";

const DAY = "2026-09-07";
const CANDIDATE = "d".repeat(40);

function passedStep(id: string, patch: Record<string, unknown> = {}) {
  return {
    id, command: ["kizuki", id, "--vault", "/tmp/synthetic-vault"], expected_exit: 0, exit_code: 0, passed: true,
    stdout_sha256: "0".repeat(64), stderr_sha256: "1".repeat(64),
    observation: { stored: null, duplicates: null, proposals: null, errors: null, degraded: [], withheld: null, hit_ids: [], consent: null, purge: null, last_run: null },
    failure: null, ...patch,
  };
}
function caseReceipt(patch: Partial<CaseReceipt> & Pick<CaseReceipt, "format" | "connector_id">): CaseReceipt {
  return {
    source_key: null, invalid_source_key: null, expected_events: 1, expected_proposals: 2,
    expected_repeat_duplicates: 0, expected_last_batch_stored: 1,
    steps: REQUIRED_EVIDENCE_STEPS["file-import"].map(id => passedStep(id)), failures: [], ...patch,
  } as CaseReceipt;
}
function emitInto(cases: CaseReceipt[]) {
  const report = mkdtempSync(join(tmpdir(), "kizuki-file-import-evidence-"));
  emitFileImportConnectorEvidence(report, CANDIDATE, DAY, cases);
  const directory = join(report, "connector-evidence");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8"));
  const names = readdirSync(directory).filter(name => name !== "index.json");
  const receipts = Object.fromEntries(names.map(name => [name.replace(/\.json$/, ""), JSON.parse(readFileSync(join(directory, name), "utf8"))]));
  rmSync(report, { recursive: true, force: true });
  return { index, receipts };
}
function reasonOf(run: () => unknown): string {
  try { run(); throw new Error("expected throw"); }
  catch (error) {
    expect(error).toBeInstanceOf(EvidenceError);
    return (error as EvidenceError).reason;
  }
}

test("every file format's promoted receipt is consumable for its own connector gate", () => {
  expect(connectorProducerRevision(EVALUATOR_ROOT)).toMatch(/^[a-f0-9]{64}$/);
  const cases = fileImportFixtures(DAY).map(fixture => caseReceipt({ format: fixture.format, connector_id: fixture.connector }));
  const { index, receipts } = emitInto(cases);
  expect(index.unresolved).toEqual([]);
  expect(Object.keys(receipts).sort()).toEqual([
    "chatgpt-export", "claude-export", "ics", "markdown-folder", "omnivore", "pocket", "whatsapp-export", "x-archive",
  ]);
  for (const [id, receipt] of Object.entries(receipts)) {
    expect(receipt.evidence_class).toBe("file-import");
    expect(receipt.acceptance_credit).toBe(true);
    // The receipt survives every denial the evaluator applies. It still buys no
    // credit: the connector family pins the evaluator's own module alone, so a
    // revision computed over it binds bytes every operator already holds.
    expect(consumeConnectorReceipt(receipt, EVALUATOR_ROOT, CANDIDATE, `connector.${id}`)).toEqual({
      status: "UNVERIFIABLE", reason: "connector-producer-not-landed", creditDigest: false,
    });
  }
  expect(index.emissions.every((row: { row_counts: Record<string, number> }) => row.row_counts.events_stored === 1)).toBe(true);
});

test("a format whose cases partially failed withholds credit and consumes to FAIL", () => {
  const cases = fileImportFixtures(DAY).map(fixture => fixture.format === "pocket"
    ? caseReceipt({
        format: fixture.format, connector_id: fixture.connector, failures: ["invalid:invalid-import:unexpected-import-counts"],
        steps: REQUIRED_EVIDENCE_STEPS["file-import"].map(id => passedStep(id, id === "repeat-import" ? { passed: false, exit_code: 1, failure: "unexpected-import-counts" } : {})),
      })
    : caseReceipt({ format: fixture.format, connector_id: fixture.connector }));
  const { index, receipts } = emitInto(cases);
  expect(index.unresolved).toEqual([]);
  expect(receipts["pocket"].acceptance_credit).toBe(false);
  expect(reasonOf(() => consumeConnectorReceipt(receipts["pocket"], EVALUATOR_ROOT, CANDIDATE, "connector.pocket"))).toBe("acceptance-credit-withheld");
  // Withheld credit is refused outright; a passing sibling reaches the terminal
  // verdict instead, which is UNVERIFIABLE until a producer entrypoint is pinned.
  expect(consumeConnectorReceipt(receipts["ics"], EVALUATOR_ROOT, CANDIDATE, "connector.ics")).toEqual({
    status: "UNVERIFIABLE", reason: "connector-producer-not-landed", creditDigest: false,
  });
});

test("a format the harness never reached names its blocker instead of emitting a receipt", () => {
  const { index, receipts } = emitInto(fileImportFixtures(DAY)
    .filter(fixture => fixture.format !== "omnivore")
    .map(fixture => caseReceipt({
      format: fixture.format, connector_id: fixture.connector,
      steps: fixture.format === "ics" ? [passedStep("init", { exit_code: -1, passed: false })] : REQUIRED_EVIDENCE_STEPS["file-import"].map(id => passedStep(id)),
    })));
  expect(index.unresolved.sort()).toEqual([
    "kizuki.import-omnivore:no-command-was-executed",
    "kizuki.ics:no-command-was-executed",
  ].sort());
  expect(Object.keys(receipts)).not.toContain("omnivore");
  expect(Object.keys(receipts)).not.toContain("ics");
});

test("the recorded limits stay what the harness observed, per failure mode", () => {
  for (const fixture of fileImportFixtures(DAY)) {
    const limits = fileImportLimits(fixture);
    expect(limits[0]).toBe(FILE_IMPORT_SHARED_LIMIT);
    expect(limits[1]).toContain(fixture.invalid_error);
    expect(limits).toHaveLength(2);
  }
  expect(fileImportLimits({ invalid_mode: "blocked", invalid_error: "JSON" })[1]).toContain("refused before enrollment");
  expect(fileImportLimits({ invalid_mode: "partial", invalid_error: "not_utf8" })[1]).toContain("stay queryable");
});
