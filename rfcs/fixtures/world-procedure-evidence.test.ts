/** Design-only check that procedure usefulness stays separate from support strength. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-procedure-evidence-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  procedure: {
    assistance: string;
    independent_mastery: boolean;
  };
  support: {
    independent_root_count: number;
    root_refs: string[];
    copied_feedback_refs: string[];
    copied_feedback_is_independent_witness: boolean;
  };
  usefulness: {
    helped: boolean;
    from_retrieval_count: boolean;
  };
  applicability: {
    limits: string[];
    counterexample_ref: string;
  };
  freshness: {
    observed_at: string;
    last_validated_at: string;
  };
  confidence: {
    value: number;
    retrieval_count: number;
    retrieval_does_not_increase_confidence: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function procedureErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "assisted-procedure-usefulness") errors.push("unexpected example id");
  if (example.procedure.assistance !== "assisted") errors.push("procedure must remain assisted");
  if (example.procedure.independent_mastery) errors.push("assisted work labeled independent mastery");
  if (example.support.independent_root_count !== 1) errors.push("independent support count drifted");
  if (example.support.root_refs.join(",") !== "r_owner_demo") errors.push("support lineage drifted");
  if (example.support.copied_feedback_is_independent_witness) {
    errors.push("copied feedback counted as another witness");
  }
  if (example.support.copied_feedback_refs.length === 0) errors.push("copied feedback lineage missing");
  if (example.usefulness.from_retrieval_count) errors.push("usefulness derived from retrieval count");
  if (!example.usefulness.helped) errors.push("scoped assisted usefulness lost");
  if (example.applicability.counterexample_ref !== "x_counter_unassisted") {
    errors.push("counterexample removed");
  }
  if (example.applicability.limits.length === 0) errors.push("applicability limits removed");
  if (example.freshness.observed_at !== example.freshness.last_validated_at) {
    errors.push("freshness fields disagree in this example");
  }
  if (!example.confidence.retrieval_does_not_increase_confidence) {
    errors.push("retrieval count may increase confidence");
  }
  if (example.confidence.value !== 0.5) errors.push("confidence changed without new independent support");
  if (example.confidence.retrieval_count < 2) errors.push("retrieval count must remain distinct from support");
  return errors;
}

test("the procedure example keeps usefulness separate from support strength", () => {
  expect(procedureErrors(load())).toEqual([]);
});

test("retrieval count, copied praise, or assisted mastery mutations fail", () => {
  const example = load();
  expect(procedureErrors(example)).toEqual([]);
  expect(
    procedureErrors({
      ...example,
      confidence: { ...example.confidence, value: 0.9 },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    procedureErrors({
      ...example,
      support: { ...example.support, copied_feedback_is_independent_witness: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    procedureErrors({
      ...example,
      applicability: { ...example.applicability, counterexample_ref: "" },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    procedureErrors({
      ...example,
      procedure: { ...example.procedure, independent_mastery: true },
    }).length,
  ).toBeGreaterThan(0);
});
