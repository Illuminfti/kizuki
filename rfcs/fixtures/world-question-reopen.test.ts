/** Design-only check that contradiction reopens a resolved question. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-question-reopen-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  question: {
    id: string;
    lifecycle: string;
    prior_lifecycle: string;
    abandoned: boolean;
    survives_source_conversation: boolean;
  };
  resolution: {
    resolved_by_ref: string;
    contradicted_by_ref: string;
    contradiction_reopens: boolean;
    copied_answer_resolves: boolean;
  };
  abandonment: {
    abandoned_is_resolved: boolean;
    silence_is_resolution: boolean;
  };
  oracle: {
    lifecycle: string;
    resolved: boolean;
    abandoned: boolean;
    prior_resolution_survives_contradiction: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function reopenErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "contradiction-reopens-resolved-question") errors.push("unexpected example id");
  if (example.question.lifecycle !== "reopened") errors.push("question did not reopen");
  if (example.question.prior_lifecycle !== "resolved") errors.push("prior resolved state dropped");
  if (example.question.abandoned) errors.push("reopened question labeled abandoned");
  if (!example.question.survives_source_conversation) errors.push("question died with its conversation");
  if (!example.resolution.contradiction_reopens) errors.push("contradiction did not reopen");
  if (example.resolution.copied_answer_resolves) errors.push("copied answer treated as resolution");
  if (example.abandonment.abandoned_is_resolved) errors.push("abandonment counted as resolution");
  if (example.abandonment.silence_is_resolution) errors.push("silence counted as resolution");
  if (example.oracle.lifecycle !== "reopened") errors.push("oracle lifecycle drifted");
  if (example.oracle.resolved) errors.push("reopened question still marked resolved");
  if (example.oracle.abandoned) errors.push("reopened question marked abandoned");
  if (example.oracle.prior_resolution_survives_contradiction) {
    errors.push("prior resolution survived a contradiction");
  }
  return errors;
}

test("a later contradiction reopens a resolved question", () => {
  expect(reopenErrors(load())).toEqual([]);
});

test("kept resolution, abandonment-as-resolution, or copied-answer resolution fail", () => {
  const example = load();
  expect(reopenErrors(example)).toEqual([]);
  expect(
    reopenErrors({
      ...example,
      question: { ...example.question, lifecycle: "resolved" },
      oracle: { ...example.oracle, lifecycle: "resolved", resolved: true, prior_resolution_survives_contradiction: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    reopenErrors({
      ...example,
      question: { ...example.question, lifecycle: "abandoned", abandoned: true },
      abandonment: { abandoned_is_resolved: true, silence_is_resolution: true },
      oracle: { ...example.oracle, lifecycle: "abandoned", abandoned: true, resolved: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    reopenErrors({
      ...example,
      resolution: { ...example.resolution, copied_answer_resolves: true, contradiction_reopens: false },
    }).length,
  ).toBeGreaterThan(0);
});
