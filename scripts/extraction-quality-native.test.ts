import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus } from "./evaluate-extraction";
import {
  mapImportedEvidence, persistedReference, runNativeQuality, verifyNativeArtifact,
} from "./extraction-quality-native";

const corpus = loadCorpus(join(import.meta.dir, "fixtures/extraction-quality-v1.json"));
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("persisted reference uses observation time for raw null, preserving explicit valid time", () => {
  const persisted = persistedReference(corpus);
  expect(corpus.cases[0]?.expected[0]?.valid_from).toBeNull();
  expect(persisted.cases[0]?.expected[0]?.valid_from).toBe("2026-08-02T10:00:00.000Z");
  expect(persisted.cases[1]?.expected[0]?.valid_from).toBe("2026-01-01T00:00:00.000Z");
  expect(persisted.cases[1]?.expected[0]?.valid_to).toBe("2026-05-01T00:00:00.000Z");
});

test("evidence binding refuses fabricated records, missing roles and omitted records", () => {
  const item = corpus.cases[9]!;
  const events = item.records.map((record, index) => ({ ...record, event_id: `event-${index}`, source_record_id: record.id }));
  expect(mapImportedEvidence(item, events)).toEqual({ "q10-a": "event-0", "q10-b": "event-1" });
  expect(() => mapImportedEvidence(item, events.slice(1))).toThrow();
  expect(() => mapImportedEvidence(item, events.map((event) => ({ ...event, text: "fabricated evidence" })))).toThrow();
  expect(() => mapImportedEvidence(item, events.map((event) => ({ ...event, subjects: [] })))).toThrow();
  expect(() => mapImportedEvidence(item, [events[0]!, events[0]!])).toThrow();
});

test("a matching-looking source SHA without a valid checksummed artifact is refused", () => {
  const path = mkdtempSync(join(tmpdir(), "quality-invalid-artifact-")); directories.push(path);
  writeFileSync(join(path, "BUILD.json"), JSON.stringify({ source_sha: "a".repeat(40) }));
  expect(() => verifyNativeArtifact(path, "a".repeat(40))).toThrow();
});

test("the complete offline corpus uses native import, model filing, CLI and MCP consumers", async () => {
  const result = await runNativeQuality();
  expect(result.execution_mode).toBe("source_cli");
  expect(result.model_quality_claim).toBe(false);
  expect(result.raw_score.passed).toBe(true);
  expect(result.cases).toHaveLength(12);
  expect(result.cases.map((row) => row.case_id)).toEqual(corpus.cases.map((row) => row.id));
  const direct = result.cases[0]!;
  expect(direct.model_requests).toBe(1);
  expect(direct.claims.length).toBe(1);
  expect(direct.claims[0]?.object).toBe("Orchard library coordinator");
  expect(direct.claims[0]?.model_ref).toBe("kizuki.llm.openai-compatible:quality-scripted@127.0.0.1");
  expect(direct.consumers.before.ledger_recalled).toEqual(["q01-a"]);
  expect(direct.consumers.after.ledger_recalled).toEqual(["q01-a"]);
  expect(direct.consumers.before.public_disclosures).toBe(0);
  expect(direct.consumers.after.public_disclosures).toBe(0);
  expect(direct.consumers.before.canon[0]?.authority).toBe("model_inference");
  expect(direct.consumers.before.canon_supported_matches).toEqual(direct.consumers.before.expected_canon);
  expect(direct.consumers.before.expected_canon).toHaveLength(1);
  expect(result.cases[4]?.claims).toEqual([]);
  expect(result.cases[4]?.status).toBe("ok");
  expect(result.controls.denied.model_requests).toBe(0);
  expect(result.controls.denied.claims).toBe(0);
  expect(result.controls.unavailable.model_requests).toBe(1);
  expect(result.controls.unavailable.status).toBe("unavailable");
  expect(result.controls.malformed.status).toBe("rejected");
  expect(result.controls.recovery.no_extra_model_calls).toBe(true);
  expect(result.controls.recovery.undo_restored_bytes).toBe(true);
  expect(result.controls.recovery.restored_recall).toBe(true);
  // These assertions distinguish tooling qualification from product success:
  // a rejected benign response or lost event roles must remain visible.
  const compatibility = result.cases[11]!;
  expect(compatibility.model_requests).toBe(1);
  expect(compatibility.raw_response_observed).toBe(true);
  if (compatibility.status !== "ok") {
    expect(result.persisted_score.passed).toBe(false);
    expect(result.passed).toBe(false);
    expect(compatibility.failures).toContain("native_unavailable");
  }
  if (!result.cases[9]!.event_roles_present) {
    expect(result.cases[9]!.failures).toContain("per_event_subject_roles_missing");
    expect(result.passed).toBe(false);
  }
}, 180_000);
