/** Design-only check that missing Concept sections stay absent. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-concept-absence-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  card: {
    concept_ref: string;
    definition_present: boolean;
    applications_present: boolean;
    open_questions_present: boolean;
    applications_status: string;
    open_questions_status: string;
  };
  epistemic: {
    exposure: boolean;
    explanation: boolean;
    application: boolean;
    demonstrated_performance: boolean;
    exposure_implies_explanation: boolean;
    explanation_implies_application: boolean;
    application_implies_mastery: boolean;
  };
  oracle: {
    fabricated_empty_applications: boolean;
    fabricated_empty_questions: boolean;
    view_status: string;
    complete_success: boolean;
    independent_performance_count: number;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function conceptErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "missing-concept-sections-stay-absent") errors.push("unexpected example id");
  if (!example.card.definition_present) errors.push("present definition dropped");
  if (example.card.applications_present) errors.push("missing applications invented");
  if (example.card.open_questions_present) errors.push("missing questions invented");
  if (example.card.applications_status !== "absent") errors.push("applications not marked absent");
  if (example.card.open_questions_status !== "unavailable") errors.push("questions not marked unavailable");
  if (!example.epistemic.exposure) errors.push("recorded exposure dropped");
  if (example.epistemic.explanation) errors.push("explanation inferred from exposure");
  if (example.epistemic.application) errors.push("application inferred without evidence");
  if (example.epistemic.demonstrated_performance) errors.push("mastery inferred without demonstration");
  if (example.epistemic.exposure_implies_explanation) errors.push("exposure treated as explanation");
  if (example.epistemic.explanation_implies_application) errors.push("explanation treated as application");
  if (example.epistemic.application_implies_mastery) errors.push("application treated as mastery");
  if (example.oracle.fabricated_empty_applications) errors.push("empty applications presented as success");
  if (example.oracle.fabricated_empty_questions) errors.push("empty questions presented as success");
  if (example.oracle.view_status !== "partial") errors.push("partial card labeled complete");
  if (example.oracle.complete_success) errors.push("partial card counted as complete success");
  if (example.oracle.independent_performance_count !== 0) errors.push("performance count invented");
  return errors;
}

test("missing Concept sections stay absent and exposure is not mastery", () => {
  expect(conceptErrors(load())).toEqual([]);
});

test("fabricated empty sections or inferred epistemic upgrades fail", () => {
  const example = load();
  expect(conceptErrors(example)).toEqual([]);
  expect(
    conceptErrors({
      ...example,
      card: {
        ...example.card,
        applications_present: true,
        applications_status: "empty",
      },
      oracle: { ...example.oracle, fabricated_empty_applications: true, complete_success: true, view_status: "current" },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    conceptErrors({
      ...example,
      card: {
        ...example.card,
        open_questions_present: true,
        open_questions_status: "empty",
      },
      oracle: { ...example.oracle, fabricated_empty_questions: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    conceptErrors({
      ...example,
      epistemic: {
        ...example.epistemic,
        explanation: true,
        application: true,
        demonstrated_performance: true,
        exposure_implies_explanation: true,
        explanation_implies_application: true,
        application_implies_mastery: true,
      },
      oracle: { ...example.oracle, independent_performance_count: 1, complete_success: true, view_status: "current" },
    }).length,
  ).toBeGreaterThan(0);
});
