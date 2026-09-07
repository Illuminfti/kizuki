import { expect, test } from "bun:test";
import { FILE_FORMATS, FILE_IMPORT_POLICY, fileImportFixtures } from "./file-import-proof-fixtures";
import { expectedFileImportSteps, importCounts, parseFileImportArgs, queryObservation } from "./file-import-proof";

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
