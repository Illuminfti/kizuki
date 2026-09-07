import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FILE_FORMATS, FILE_IMPORT_POLICY, fileImportFixtures } from "./file-import-proof-fixtures";
import { consentObservation, expectedFileImportSteps, importCounts, importDiagnostics, parseFileImportArgs, queryObservation } from "./file-import-proof";

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
