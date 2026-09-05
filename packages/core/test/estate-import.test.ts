import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept, openLedger, readSince, planEstateImport, initVault, runPurge, verifyPurge, createVaultFts5Port } from "../src/index";
import { buildEstatePlan } from "../src/import/estate";
import { sha256Hex } from "../src/util/hash";

function record(id = "42") {
  return { record_id: id, domain: "memory", text: "Synthetic evidence.",
    occurred_at: "2020-01-01T00:00:00Z", observed_at: "2020-01-02T00:00:00Z",
    valid_from: null as string | null, valid_to: null as string | null, asserted_at: null,
    authority: "connector_evidence", sensitivity: "personal", subjects: [], aliases: [],
    correction_of: null as string | null, supersedes: [] as string[], attachments: [],
    provenance: { sha256: sha256Hex("Synthetic evidence."), line_start: 1, line_end: 1 },
    state: null as string | null, value: null as number | null };
}
function fixture(records = [record()]) {
  return { schema: "kizuki.estate-slice/v1", sources: [{ source_id: "source-a", consent_generation: 2, records }] };
}
function auth(source: string, ids = ["source-a"]) {
  return { schema: "kizuki.estate-authorization/v1", source_sha256: sha256Hex(source), source_ids: ids,
    generation: 2, revoked: false, purpose: "estate-import", retention: "persistent_owned_copy",
    egress: "local_only", sensitivity_floor: "private", allowed_fields: ["text", "times", "authority", "provenance", "subjects", "aliases", "relationships", "attachments", "domain_state"] };
}
function plan(input = fixture(), change: Record<string, unknown> = {}) {
  const source = JSON.stringify(input);
  return buildEstatePlan(source, JSON.stringify({ ...auth(source), ...change }));
}
const codes = (result: ReturnType<typeof plan>) => result.report.issues.map((issue) => issue.code);

describe("estate slice dry-run", () => {
  test("source identity, provenance and retry mapping use existing accept without source mutation", () => {
    const input = fixture();
    input.sources.push({ ...input.sources[0]!, source_id: "source-b" });
    const source = JSON.stringify(input);
    const authorization = JSON.stringify(auth(source, ["source-a", "source-b"]));
    const result = buildEstatePlan(source, authorization);
    expect(result.report.status).toBe("compatible");
    expect(planEstateImport(source, authorization)).toEqual(result.report);
    expect(JSON.stringify(result.report)).not.toContain("Synthetic evidence");
    expect(result.templates[0]!.source_record_id).not.toBe(result.templates[1]!.source_record_id);
    const db = openLedger(":memory:");
    try {
      for (const event of result.templates) expect(accept(db, event).status).toBe("stored");
      for (const event of result.templates) expect(accept(db, event).status).toBe("duplicate");
      expect(readSince(db, null, 10).events).toHaveLength(2);
      expect(JSON.stringify(input)).toBe(source);
    } finally { db.close(); }
    expect(() => planEstateImport(source + " ", authorization)).toThrow("authorization_digest_mismatch");
  });
  test("meaningful times and authority do not become import time or native owner claims", () => {
    const known = record(); known.valid_from = "2019-12-01T00:00:00Z";
    const historical = plan(fixture([known]));
    expect(codes(historical)).toContain("historical_claim_times_metadata_only");
    expect(historical.templates[0]!.occurred_at).toBe(known.occurred_at);
    expect(historical.templates[0]!.observed_at).toBe(known.observed_at);
    const unknown = JSON.parse(JSON.stringify(fixture())); unknown.sources[0].records[0].occurred_at = null;
    expect(codes(plan(unknown))).toContain("unknown_event_time");
    const foreign = record(); foreign.authority = "owner_correction";
    expect(codes(plan(fixture([foreign])))).toContain("foreign_authority_not_applied");
    expect(plan(fixture([foreign])).templates).toEqual([]);
  });
  test("ambiguous aliases and correction relations are not silently applied", () => {
    const input = JSON.parse(JSON.stringify(fixture([record("a"), record("b")])));
    input.sources[0].records[0].aliases = [{ subject_id: "person:a", display_name: "Same" }, { subject_id: "person:b", display_name: "Same" }];
    input.sources[0].records[0].correction_of = "missing";
    const result = plan(input);
    expect(codes(result)).toContain("alias_ambiguous");
    expect(codes(result)).toContain("relationship_unresolved");
    expect(result.templates).toEqual([]);
    const correction = record("b"); correction.supersedes = ["a"];
    expect(codes(plan(fixture([record("a"), correction])))).toContain("relationships_not_applied");
  });
  test("retention, fields, floor and egress fail closed", () => {
    expect(codes(plan(fixture(), { retention: "derived_until_revoked" }))).toContain("retention_incompatible");
    expect(codes(plan(fixture(), { allowed_fields: ["provenance"] }))).toContain("field_not_allowed");
    expect(codes(plan(fixture(), { egress: "remote" }))).toContain("egress_unsupported");
    expect(plan().templates[0]!.sensitivity_hint).toBe("private");
    expect(() => plan(fixture(), { source_ids: ["different"] })).toThrow("authorization_source_mismatch");
    expect(() => plan(fixture(), { generation: 1 })).toThrow("authorization_generation_mismatch");
  });
  test("revoked source blocks planning, with no production revocation claim", () => {
    const result = plan(fixture(), { revoked: true });
    expect(codes(result)).toContain("authorization_revoked");
    expect(result.templates).toEqual([]);
    expect(result.report.limitations).toContain("durable_authorization_and_revocation_not_implemented");
    expect(result.report.limitations).toContain("disconnect_is_not_revocation");
  });
  test("attachments and product domains remain explicit losses, missing is not zero", () => {
    const input = JSON.parse(JSON.stringify(fixture()));
    input.sources[0].records[0].attachments = [{ attachment_id: "file-a", media_type: "text/plain" }];
    expect(codes(plan(input))).toContain("attachment_bytes_not_transferred");
    const missing = record(); missing.domain = "metrics";
    const zero = { ...missing, record_id: "zero", value: 0 };
    const skipped = { ...record("habit"), domain: "habits", state: "skipped" };
    const result = plan(fixture([missing, zero, skipped]));
    expect(codes(result).filter((code) => code === "domain_not_owned")).toHaveLength(3);
    expect(result.templates).toEqual([]);
    expect(plan(fixture([missing])).report.plan_sha256).not.toBe(plan(fixture([zero])).report.plan_sha256);
  });
  test("synthetic revocation uses native purge and preserves original canon and unrelated evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "estate-fixture-"));
    const vault = join(directory, "target");
    initVault(vault);
    const original = join(directory, "original.md");
    writeFileSync(original, "Original synthetic canon remains unchanged.\n");
    const before = readFileSync(original);
    const db = openLedger(":memory:");
    const retrieval = createVaultFts5Port(vault);
    try {
      const input = fixture([record("target"), record("other")]);
      const compatible = plan(input);
      for (const event of compatible.templates) expect(accept(db, event).status).toBe("stored");
      // The authorizer is fixture data only; production planner does not implement revocation.
      expect(plan(input, { revoked: true }).templates).toEqual([]);
      const stored = readSince(db, null, 10).events.find((event) => event.source_record_id === compatible.templates[0]!.source_record_id)!;
      await retrieval.upsert([{ doc_id: `event:${stored.event_id}`, kind: "event", title: "", text: stored.text,
        sensitivity: "private", taint: "quoted", authority: "connector_evidence", subjects: [], provenance: [stored.event_id],
        occurred_at: stored.occurred_at, updated_at: stored.observed_at }]);
      const remove = retrieval.remove.bind(retrieval);
      retrieval.remove = async () => { throw new Error("synthetic retrieval interruption"); };
      const result = await runPurge(db, vault, { connector_id: "estate-slice", source_record_id: compatible.templates[0]!.source_record_id }, "synthetic revoke", { retrieval });
      expect(result.receipts).toHaveLength(1);
      expect(result.purge_ops[0]!.state).toBe("pending");
      expect((await verifyPurge(db, vault, result.receipts[0]!.receipt_id, { retrieval })).ok).toBe(false);
      retrieval.remove = remove;
      await retrieval.remove(result.purge_ops[0]!.ids);
      const proof = await verifyPurge(db, vault, result.receipts[0]!.receipt_id, { retrieval });
      expect(proof.ok).toBe(true);
      const remaining = readSince(db, null, 10).events;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source_record_id).toBe(compatible.templates[1]!.source_record_id);
      expect(readFileSync(original)).toEqual(before);
    } finally { await retrieval.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("malformed, oversized, secret-shaped and duplicate inputs fail without echoing values", () => {
    expect(() => planEstateImport("x".repeat(1_048_577), "{}")).toThrow("source_too_large");
    expect(() => planEstateImport('{"secret":"synthetic-canary"}', "{}")).toThrow("invalid_source");
    expect(() => plan(fixture([record(), record()]))).toThrow("duplicate_record");
    expect(() => plan(fixture(), { access_token: "synthetic-canary" })).toThrow("invalid_authorization");
  });
});
