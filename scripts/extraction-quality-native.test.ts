import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, sha256 } from "./evaluate-extraction";
import { checksumManifest } from "./release-artifacts";
import { copyPackage } from "./native-proof-evidence";
import { nativeReleaseTarget } from "./release-targets";
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

const artifactNames = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
const sourceSha = "a".repeat(40);
const validBuild = { schema: "kizuki.release-build/v1", source_sha: sourceSha,
  target: nativeReleaseTarget().target, bun_version: Bun.version } as const;

function artifact(build: unknown): string {
  const path = mkdtempSync(join(tmpdir(), "quality-artifact-metadata-")); directories.push(path);
  for (const name of artifactNames) {
    writeFileSync(join(path, name), name === "BUILD.json" ? JSON.stringify(build) : `synthetic metadata fixture: ${name}`);
  }
  writeFileSync(join(path, "SHA256SUMS"), checksumManifest(path, artifactNames));
  return path;
}

test("artifact metadata binds a complete native build and the expected source revision", () => {
  const path = artifact(validBuild);
  const identity = verifyNativeArtifact(path, sourceSha);
  expect(identity.build).toEqual(validBuild);
  expect(Object.keys(identity.files_sha256).sort()).toEqual([...artifactNames].sort());
  for (const name of artifactNames) expect(identity.files_sha256[name]).toBe(sha256(readFileSync(join(path, name))));
  expect(identity.checksum_manifest).toBe(readFileSync(join(path, "SHA256SUMS"), "utf8"));
  expect(identity.manifest_sha256).toBe(sha256(identity.checksum_manifest));
  expect(() => verifyNativeArtifact(path, "b".repeat(40))).toThrow();
});

test("artifact identity binds copied MCP bytes even when CLI bytes and build metadata match", () => {
  const path = artifact(validBuild), copy = `${path}-copy`;
  directories.push(copy);
  const original = verifyNativeArtifact(path, sourceSha);
  cpSync(path, copy, { recursive: true, errorOnExist: true });
  expect(verifyNativeArtifact(copy, sourceSha)).toEqual(original);
  writeFileSync(join(copy, "kizuki-mcp"), "different synthetic MCP executable");
  expect(() => verifyNativeArtifact(copy, sourceSha)).toThrow("package-checksum-mismatch");
  writeFileSync(join(copy, "SHA256SUMS"), checksumManifest(copy, artifactNames));
  const changed = verifyNativeArtifact(copy, sourceSha);
  expect(changed.build).toEqual(original.build);
  expect(changed.files_sha256.kizuki).toBe(original.files_sha256.kizuki);
  expect(changed.files_sha256["kizuki-mcp"]).not.toBe(original.files_sha256["kizuki-mcp"]);
  expect(changed.manifest_sha256).not.toBe(original.manifest_sha256);
  expect(changed).not.toEqual(original);
});

test.each([
  null,
  [],
  { source_sha: sourceSha },
  { ...validBuild, extra: "untrusted" },
  { ...validBuild, schema: "wrong-schema" },
  { ...validBuild, source_sha: "not-a-source-revision" },
  { ...validBuild, target: "wrong-os-wrong-arch" },
  { ...validBuild, target: validBuild.target === "bun-linux-x64-baseline" ? "bun-darwin-arm64" : "bun-linux-x64-baseline" },
  { ...validBuild, bun_version: "0.0.0" },
].map((build) => [build] as const))("artifact checksums cannot authorize malformed or incompatible build metadata %#", (build) => {
  expect(() => verifyNativeArtifact(artifact(build), sourceSha)).toThrow();
});

test("artifact root must be a real directory even when the linked contents have valid checksums", () => {
  const path = artifact(validBuild), link = `${path}-link`;
  directories.push(link);
  symlinkSync(path, link, "dir");
  expect(() => verifyNativeArtifact(link, sourceSha)).toThrow("artifact must be a regular directory");
  expect(() => verifyNativeArtifact(join(path, "BUILD.json"), sourceSha)).toThrow("artifact must be a regular directory");
});

test("the complete offline corpus uses native import, model filing, CLI and MCP consumers", async () => {
  const result = await runNativeQuality();
  expect(result.schema).toBe("kizuki.native-extraction-quality/v2");
  expect(result.artifact).toBeNull();
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


test("native proof copies exactly the registered package without traversing unrelated entries", () => {
  const path = artifact(validBuild), copy = `${path}-bounded-copy`; directories.push(copy);
  symlinkSync("/a/synthetic/unrelated/path", join(path, "unrelated-link"));
  copyPackage(path, copy);
  expect(verifyNativeArtifact(copy, sourceSha)).toEqual(verifyNativeArtifact(path, sourceSha));
  expect(() => readFileSync(join(copy, "unrelated-link"))).toThrow();
});
