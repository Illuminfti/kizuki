/** Design-only check that Cue failure modes stay distinct from genuine quiet. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-cue-coverage-design.json");

type StateKind = "missing_coverage" | "stale_consolidation" | "provider_failure" | "genuine_quiet";

type CueState = {
  kind: StateKind;
  material_change: boolean;
  actionable: boolean;
  quiet: boolean;
  interrupt: boolean;
  reason: string;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  states: Record<StateKind, CueState>;
  oracle: {
    kinds_collapsed: boolean;
    quiet_from_missing_coverage: boolean;
    quiet_from_stale_consolidation: boolean;
    quiet_from_provider_failure: boolean;
    missing_coverage_is_quiet: boolean;
    provider_failure_is_success: boolean;
    stale_treated_as_current: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function coverageErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "coverage-stale-failure-quiet-are-distinct") errors.push("unexpected example id");
  const kinds = Object.values(example.states).map((state) => state.kind);
  if (new Set(kinds).size !== 4) errors.push("cue states collapsed");
  const missing = example.states.missing_coverage;
  const stale = example.states.stale_consolidation;
  const failure = example.states.provider_failure;
  const quiet = example.states.genuine_quiet;
  if (missing.quiet || missing.interrupt || missing.reason !== "source_unobserved") {
    errors.push("missing coverage drifted into quiet or interrupt");
  }
  if (stale.quiet || stale.interrupt || stale.reason !== "summary_older_than_ledger") {
    errors.push("stale consolidation treated as current or quiet");
  }
  if (failure.quiet || failure.interrupt || failure.reason !== "model_unavailable") {
    errors.push("provider failure treated as quiet or success");
  }
  if (!quiet.quiet || quiet.interrupt || quiet.reason !== "no_material_change") {
    errors.push("genuine quiet lost its quiet reason");
  }
  if (example.oracle.kinds_collapsed) errors.push("oracle collapsed cue kinds");
  if (example.oracle.quiet_from_missing_coverage || example.oracle.missing_coverage_is_quiet) {
    errors.push("missing coverage reported as quiet");
  }
  if (example.oracle.quiet_from_stale_consolidation || example.oracle.stale_treated_as_current) {
    errors.push("stale consolidation reported as current quiet");
  }
  if (example.oracle.quiet_from_provider_failure || example.oracle.provider_failure_is_success) {
    errors.push("provider failure reported as quiet or success");
  }
  return errors;
}

test("missing coverage, stale consolidation, provider failure, and quiet stay distinct", () => {
  expect(coverageErrors(load())).toEqual([]);
});

test("collapsing a failure mode into quiet fails", () => {
  const example = load();
  expect(coverageErrors(example)).toEqual([]);
  expect(
    coverageErrors({
      ...example,
      states: {
        ...example.states,
        missing_coverage: { ...example.states.missing_coverage, quiet: true, reason: "no_material_change" },
      },
      oracle: { ...example.oracle, quiet_from_missing_coverage: true, missing_coverage_is_quiet: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    coverageErrors({
      ...example,
      states: {
        ...example.states,
        provider_failure: { ...example.states.provider_failure, quiet: true, kind: "genuine_quiet" },
      },
      oracle: { ...example.oracle, kinds_collapsed: true, quiet_from_provider_failure: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    coverageErrors({
      ...example,
      states: {
        ...example.states,
        stale_consolidation: { ...example.states.stale_consolidation, quiet: true, reason: "no_material_change" },
      },
      oracle: { ...example.oracle, stale_treated_as_current: true, quiet_from_stale_consolidation: true },
    }).length,
  ).toBeGreaterThan(0);
});
