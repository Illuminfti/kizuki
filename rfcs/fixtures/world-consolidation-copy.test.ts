/** Design-only check that copies and paraphrases do not inflate support. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-copy-design.json");

type Derivative = {
  kind: string;
  source_ref: string;
  independent_root: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  source: { kind: string; independent_root: boolean };
  derivatives: { copy: Derivative; paraphrase: Derivative };
  oracle: {
    copy_inflates_support: boolean;
    paraphrase_inflates_support: boolean;
    inflates_skill: boolean;
    inflates_mastery: boolean;
    inflates_truth_confidence: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function copyErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "paraphrase-does-not-inflate-support") errors.push("unexpected example id");
  if (example.source.kind !== "source_record") errors.push("source kind drifted");
  if (!example.source.independent_root) errors.push("primary source lost independent root");
  if (example.derivatives.copy.kind !== "copy") errors.push("copy kind drifted");
  if (example.derivatives.paraphrase.kind !== "ai_paraphrase") errors.push("paraphrase kind drifted");
  if (example.derivatives.copy.independent_root) errors.push("copy treated as independent root");
  if (example.derivatives.paraphrase.independent_root) errors.push("paraphrase treated as independent root");
  if (example.derivatives.copy.source_ref !== "x_r_primary") errors.push("copy lost its source");
  if (example.derivatives.paraphrase.source_ref !== "x_r_primary") errors.push("paraphrase lost its source");
  if (example.oracle.copy_inflates_support) errors.push("copy inflated support");
  if (example.oracle.paraphrase_inflates_support) errors.push("paraphrase inflated support");
  if (example.oracle.inflates_skill) errors.push("derivative inflated skill");
  if (example.oracle.inflates_mastery) errors.push("derivative inflated mastery");
  if (example.oracle.inflates_truth_confidence) errors.push("derivative inflated truth confidence");
  return errors;
}

test("copies and paraphrases of one source do not inflate support", () => {
  expect(copyErrors(load())).toEqual([]);
});

test("counting a copy or paraphrase as independent support fails", () => {
  const example = load();
  expect(copyErrors(example)).toEqual([]);
  expect(
    copyErrors({
      ...example,
      derivatives: {
        ...example.derivatives,
        copy: { ...example.derivatives.copy, independent_root: true },
      },
      oracle: { ...example.oracle, copy_inflates_support: true, inflates_truth_confidence: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    copyErrors({
      ...example,
      derivatives: {
        ...example.derivatives,
        paraphrase: { ...example.derivatives.paraphrase, independent_root: true },
      },
      oracle: {
        ...example.oracle,
        paraphrase_inflates_support: true,
        inflates_skill: true,
        inflates_mastery: true,
      },
    }).length,
  ).toBeGreaterThan(0);
});
