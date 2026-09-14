/** Design-only check that partial World Slice coverage is advertised. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-slice-partial-design.json");

type Coverage = { kind: string; status: string; provider_available: boolean };
type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  request: { task: string; requested_kinds: string[] };
  coverage: Coverage[];
  oracle: {
    complete: boolean;
    omitted_kinds_count: number;
    unavailable_kinds: string[];
    missing_provider_hidden: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function row(example: Fixture, kind: string): Coverage | undefined {
  return example.coverage.find((item) => item.kind === kind);
}

function sliceErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "partial-slice-coverage-is-advertised") errors.push("unexpected example id");
  const kinds = example.coverage.map((item) => item.kind).sort();
  const requested = [...example.request.requested_kinds].sort();
  if (kinds.join() !== requested.join()) errors.push("requested kinds omitted from coverage");
  const concept = row(example, "concept");
  const procedure = row(example, "procedure");
  const question = row(example, "question");
  const skill = row(example, "skill");
  if (concept?.status !== "included") errors.push("available concept dropped");
  if (procedure?.status !== "included") errors.push("available procedure dropped");
  if (question?.status !== "unavailable") errors.push("missing question provider hidden");
  if (skill?.status !== "unavailable") errors.push("missing skill provider hidden");
  if (question?.provider_available) errors.push("question provider marked available");
  if (skill?.provider_available) errors.push("skill provider marked available");
  if (example.oracle.complete) errors.push("partial slice labeled complete");
  if (example.oracle.omitted_kinds_count !== 0) errors.push("missing providers omitted instead of advertised");
  if (example.oracle.unavailable_kinds.join() !== "question,skill") errors.push("unavailable kinds drifted");
  if (example.oracle.missing_provider_hidden) errors.push("missing providers hidden");
  return errors;
}

test("partial World Slice coverage is advertised", () => {
  expect(sliceErrors(load())).toEqual([]);
});

test("omitted providers or a complete label fail", () => {
  const example = load();
  expect(sliceErrors(example)).toEqual([]);
  expect(
    sliceErrors({
      ...example,
      coverage: example.coverage.filter((item) => item.kind !== "question" && item.kind !== "skill"),
      oracle: { ...example.oracle, complete: true, omitted_kinds_count: 2, unavailable_kinds: [], missing_provider_hidden: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    sliceErrors({
      ...example,
      coverage: example.coverage.map((item) =>
        item.kind === "question" || item.kind === "skill"
          ? { ...item, status: "included", provider_available: true }
          : item,
      ),
      oracle: { ...example.oracle, complete: true, unavailable_kinds: [] },
    }).length,
  ).toBeGreaterThan(0);
});
