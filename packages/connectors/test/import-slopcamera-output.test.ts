import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateEventInput } from "@kizuki/core";
import { listConnectorDescriptors } from "../src/registry";
import { sha256Hex } from "../src/source-id";
import {
  SLOPCAMERA_OUTPUT_CONSENT,
  SLOPCAMERA_OUTPUT_CONNECTOR_ID,
  SLOPCAMERA_OUTPUT_PIN,
  parseSlopcameraRenderOutput,
} from "../src/import-slopcamera-output";

const observed = "2026-09-27T19:40:00.000Z";
const projectId = "project_synthetic1";
const revisionA = "a".repeat(64);
const revisionB = "b".repeat(64);
const planA = "c".repeat(64);
const planB = "d".repeat(64);
const outputA = "e".repeat(64);
const outputB = "f".repeat(64);

function reference(sha256: string, revisionSha256: string, planArtifactSha256: string): string {
  return JSON.stringify({
    bytes: 12,
    kind: "slopcamera.project-render-output-reference",
    path: "renders/candidates/take.mp4",
    planArtifactSha256,
    projectId,
    revisionSha256,
    schemaVersion: 1,
    sha256,
  });
}

const consent = { observedAt: observed, consent: SLOPCAMERA_OUTPUT_CONSENT };
const note = {
  author: "owner" as const,
  rationale: "SYNTHETIC_NOTE_ON_A",
  outputSha256: outputA,
};

test("two reused filenames stay distinct and a note stays on its digest", () => {
  const parsedA = parseSlopcameraRenderOutput(reference(outputA, revisionA, planA), { ...consent, note });
  const parsedB = parseSlopcameraRenderOutput(reference(outputB, revisionB, planB), consent);
  expect(parsedA.status).toBe("partial");
  expect(parsedB.status).toBe("partial");
  if (parsedA.status === "refused" || parsedB.status === "refused") return;
  expect(parsedA.event.source_record_id).not.toBe(parsedB.event.source_record_id);
  expect(validateEventInput(parsedA.event).ok).toBe(true);
  expect(parsedA.event.text).not.toContain("SYNTHETIC_NOTE_ON_A");
  expect(parsedA.event.text).not.toContain("renders/candidates/take.mp4");
  expect(parsedA.event.metadata["slopcamera"]).toMatchObject({
    pin: SLOPCAMERA_OUTPUT_PIN,
    note: { author: "owner", bound_output_sha256: outputA, acceptance: "absent" },
    coverage: { path_opened: false, retrieved: false, executed: false, acceptance: "absent" },
  });
  expect(parsedB.event.metadata["slopcamera"]).not.toHaveProperty("note");
  expect(parseSlopcameraRenderOutput(reference(outputB, revisionB, planB), { ...consent, note }).code)
    .toBe("note_unbound");
});

test("supplied output bytes clear only that digest", () => {
  const media = "synthetic-bytes";
  expect(sha256Hex(media)).not.toBe(outputA);
  const digest = "1".repeat(64);
  const parsed = parseSlopcameraRenderOutput(
    reference(sha256Hex(media), revisionA, planA),
    { ...consent, referencedBytes: { [sha256Hex(media)]: media } },
  );
  expect(parsed.status).toBe("partial");
  if (parsed.status !== "partial") return;
  expect(parsed.missingDigests).toEqual([planA, revisionA]);
  expect(parsed.missingDigests).not.toContain(sha256Hex(media));
  expect(parsed.event.text).toContain("bytes not retrieved");
  expect(parseSlopcameraRenderOutput(reference(digest, revisionA, planA), {
    ...consent,
    referencedBytes: { [digest]: "other" },
  }).code).toBe("digest_mismatch");
});

test("consent, paths, and unknown fields refuse before any read", () => {
  const body = reference(outputA, revisionA, planA);
  expect(parseSlopcameraRenderOutput(body, { observedAt: observed }).code).toBe("consent_required");
  expect(parseSlopcameraRenderOutput(body.replace(outputA, "../outside"), consent).code).toBe("invalid_digest");
  expect(parseSlopcameraRenderOutput(body.replace("renders/candidates/take.mp4", "../outside.mp4"), consent).code)
    .toBe("invalid_path");
  expect(parseSlopcameraRenderOutput(body.replace("renders/candidates/take.mp4", "renders/receipts/take.mp4"), consent).code)
    .toBe("invalid_path");
  expect(parseSlopcameraRenderOutput(body.replace("\"schemaVersion\":1", "\"schemaVersion\":2"), consent).code)
    .toBe("unsupported_contract");
  expect(parseSlopcameraRenderOutput(body.replace("slopcamera.project-render-output-reference", "slopcamera.project-render-receipt"), consent).code)
    .toBe("unsupported_contract");
  expect(parseSlopcameraRenderOutput(body.slice(0, -1) + ",\"fetch\":\"https://example.invalid/take.mp4\"}", consent).code)
    .toBe("unsupported_field");
  expect(parseSlopcameraRenderOutput(body, { ...consent, note: { ...note, timeRange: "0-1" } as never }).code)
    .toBe("unsupported_field");
});

test("the parser is not a registered connector and does not open files", () => {
  expect(listConnectorDescriptors().some((port) => port.id === SLOPCAMERA_OUTPUT_CONNECTOR_ID)).toBe(false);
  const source = readFileSync(new URL("../src/import-slopcamera-output.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/\breadFile|\bfetch\s*\(|node:fs|node:http|child_process/);
  expect(source).toContain(SLOPCAMERA_OUTPUT_PIN.commit);
});
