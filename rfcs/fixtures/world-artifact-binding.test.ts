/** Design-only check that failed v1 and later v2 inspections stay version-bound. Not retrieval quality. */
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(ROOT, "rfcs/fixtures");
const VALIDATOR = join(FIXTURES, "validate-world-design.ts");
const CONCEPT = "world-concept-design.json";
const LONGITUDINAL = "world-longitudinal-design.json";

type Fixture = {
  evaluation_state: string;
  status: string;
  input: {
    records: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
  };
};

function validate(dir?: string) {
  const args = dir === undefined ? [process.execPath, VALIDATOR] : [process.execPath, VALIDATOR, dir];
  return Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
}

function mutateLongitudinal(mutate: (fixture: Fixture) => void): number {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-artifact-binding-"));
  try {
    copyFileSync(join(FIXTURES, CONCEPT), join(dir, CONCEPT));
    const fixture = JSON.parse(readFileSync(join(FIXTURES, LONGITUDINAL), "utf8")) as Fixture;
    mutate(fixture);
    writeFileSync(join(dir, LONGITUDINAL), `${JSON.stringify(fixture)}\n`);
    return validate(dir).exitCode ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(fixture: Fixture, id: string): Record<string, unknown> {
  const row = fixture.input.records.find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing record ${id}`);
  return row;
}

function artifact(fixture: Fixture, id: string): Record<string, unknown> {
  const row = fixture.input.artifacts.find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing artifact ${id}`);
  return row;
}

test("unchanged fixtures bind failed v1 and successful v2 inspections", () => {
  const result = validate();
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as {
    validation: string;
    product_execution: boolean;
  };
  expect(report.validation).toBe("static_pass");
  expect(report.product_execution).toBe(false);
});

test("misbound inspection versions fail the design validator", () => {
  expect(
    mutateLongitudinal((fixture) => {
      record(fixture, "x_r_correct_version").artifact_refs = ["x_artifact_v1"];
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      delete record(fixture, "x_r_correct_version").artifact_refs;
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      record(fixture, "x_r_wrong_version").artifact_refs = ["x_artifact_v1"];
      record(fixture, "x_r_correct_version").artifact_refs = ["x_artifact_v1"];
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      artifact(fixture, "x_artifact_v2").version = "v1";
    }),
  ).not.toBe(0);
});

type ContentBinding = {
  id: string;
  evaluation_state: string;
  inspections: Array<{
    record_id: string;
    artifact_id: string;
    version: string;
    inspected_content_sha256?: string;
  }>;
};

const CONTENT_BINDING = "world-artifact-content-binding.json";
const SHA256 = /^[0-9a-f]{64}$/;

function loadContentBinding(): ContentBinding {
  return JSON.parse(readFileSync(join(FIXTURES, CONTENT_BINDING), "utf8")) as ContentBinding;
}

function loadLongitudinal(): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, LONGITUDINAL), "utf8")) as Fixture;
}

function sha256Utf8(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function contentBindingErrors(example: ContentBinding, artifacts: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "design_only") errors.push("example must remain design_only");
  if (example.id !== "exact-content-inspection-binding") errors.push("unexpected example id");
  const expected = [
    { record_id: "x_r_wrong_version", artifact_id: "x_artifact_v1", version: "v1" },
    { record_id: "x_r_correct_version", artifact_id: "x_artifact_v2", version: "v2" },
  ];
  if (example.inspections.length !== expected.length) errors.push("unexpected inspection count");
  for (const [index, want] of expected.entries()) {
    const got = example.inspections[index];
    if (got === undefined) {
      errors.push(`missing inspection ${want.record_id}`);
      continue;
    }
    if (got.record_id !== want.record_id) errors.push(`${want.record_id} lost its record binding`);
    if (got.artifact_id !== want.artifact_id) errors.push(`${want.record_id} bound the wrong artifact`);
    if (got.version !== want.version) errors.push(`${want.record_id} lost its version`);
    const hash = got.inspected_content_sha256;
    if (typeof hash !== "string" || !SHA256.test(hash)) {
      errors.push(`${want.record_id} is missing a sha256 content digest`);
      continue;
    }
    const row = artifact(artifacts, want.artifact_id);
    if (row.version !== want.version) errors.push(`${want.artifact_id} is not ${want.version}`);
    const actual = sha256Utf8(String(row.content ?? ""));
    if (hash !== actual) errors.push(`${want.record_id} does not match the artifact bytes`);
  }
  return errors;
}

test("failed v1 and successful v2 inspections bind exact artifact content hashes", () => {
  expect(contentBindingErrors(loadContentBinding(), loadLongitudinal())).toEqual([]);
});

test("content-hash counterexamples fail when bytes, versions, or refs drift", () => {
  const example = loadContentBinding();
  const artifacts = loadLongitudinal();
  expect(contentBindingErrors(example, artifacts)).toEqual([]);
  const v1 = example.inspections[0]!;
  const v2 = example.inspections[1]!;
  const cases: ContentBinding[] = [
    { ...example, evaluation_state: "not_run" },
    { ...example, inspections: [{ ...v1, inspected_content_sha256: v2.inspected_content_sha256 }, v2] },
    { ...example, inspections: [{ ...v1, inspected_content_sha256: undefined }, v2] },
    { ...example, inspections: [{ ...v1, artifact_id: "x_artifact_v2" }, v2] },
    { ...example, inspections: [] },
  ];
  for (const broken of cases) {
    expect(contentBindingErrors(broken, artifacts).length).toBeGreaterThan(0);
  }
  const mutated = loadLongitudinal();
  artifact(mutated, "x_artifact_v1").content = `${artifact(mutated, "x_artifact_v1").content}extra`;
  expect(contentBindingErrors(example, mutated).length).toBeGreaterThan(0);
});

type TextRegion = {
  id: string;
  evaluation_state: string;
  record_id: string;
  artifact_id: string;
  version: string;
  span_utf16?: [number, number] | number[];
  quote?: string;
  inspected_content_sha256?: string;
};

const TEXT_REGION = "world-artifact-text-region.json";
const QUOTE = "Copies are not independent evidence.";

function loadTextRegion(): TextRegion {
  return JSON.parse(readFileSync(join(FIXTURES, TEXT_REGION), "utf8")) as TextRegion;
}

function textRegionErrors(example: TextRegion, artifacts: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "design_only") errors.push("example must remain design_only");
  if (example.id !== "exact-text-region-inspection-binding") errors.push("unexpected example id");
  if (example.record_id !== "x_r_correct_version") errors.push("region left the v2 inspection record");
  if (example.artifact_id !== "x_artifact_v2") errors.push("region bound the wrong artifact");
  if (example.version !== "v2") errors.push("region lost its version");
  record(artifacts, example.record_id);
  const row = artifact(artifacts, example.artifact_id);
  if (row.version !== example.version) errors.push("artifact version drifted");
  const content = row.content;
  if (typeof content !== "string") {
    errors.push("artifact body is not a string");
    return errors;
  }
  const hash = example.inspected_content_sha256;
  if (typeof hash !== "string" || !SHA256.test(hash)) {
    errors.push("region is missing a sha256 content digest");
  } else if (hash !== sha256Utf8(content)) {
    errors.push("region does not match the artifact bytes");
  }
  const span = example.span_utf16;
  if (!Array.isArray(span) || span.length !== 2) {
    errors.push("region span is missing");
    return errors;
  }
  const [start, end] = span;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    errors.push("region span is not an integer half-open range");
  } else if (start < 0 || end < 0 || start >= end || end > content.length) {
    errors.push("region span is empty, reversed, or out of range");
  } else if (content.slice(start, end) !== example.quote) {
    errors.push("region quote does not match the selected bytes");
  }
  if (example.quote !== QUOTE) errors.push("region quote drifted");
  return errors;
}

test("an inspected text region binds its quote to exact artifact version and bytes", () => {
  expect(textRegionErrors(loadTextRegion(), loadLongitudinal())).toEqual([]);
});

test("text-region counterexamples fail for stale versions, changed bytes, and invalid spans", () => {
  const example = loadTextRegion();
  const artifacts = loadLongitudinal();
  expect(textRegionErrors(example, artifacts)).toEqual([]);
  const cases: TextRegion[] = [
    { ...example, evaluation_state: "not_run" },
    { ...example, record_id: "x_r_wrong_version" },
    { ...example, artifact_id: "x_artifact_v1", version: "v1" },
    { ...example, version: "v1" },
    { ...example, quote: "Copies are independent evidence." },
    { ...example, span_utf16: [101, 137] },
    { ...example, span_utf16: [103, 139] },
    { ...example, span_utf16: [138, 102] },
    { ...example, span_utf16: [102.5, 138] },
    { ...example, span_utf16: [102, 102] },
    { ...example, span_utf16: [102, 200] },
    { ...example, span_utf16: undefined },
    { ...example, inspected_content_sha256: undefined },
  ];
  for (const broken of cases) {
    expect(textRegionErrors(broken, artifacts).length).toBeGreaterThan(0);
  }
  const mutated = loadLongitudinal();
  artifact(mutated, "x_artifact_v2").content = `${artifact(mutated, "x_artifact_v2").content}extra`;
  expect(textRegionErrors(example, mutated).length).toBeGreaterThan(0);
});
