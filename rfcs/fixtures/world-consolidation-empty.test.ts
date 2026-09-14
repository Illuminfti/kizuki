/** Design-only check that empty success requires a complete accepted batch. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-empty-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  job: {
    result: string;
    empty_batch: boolean;
    batch_complete: boolean;
    batch_accepted: boolean;
    input_admission_refs: string[];
    checkpoint_advanced: boolean;
  };
  unavailable: {
    result: string;
    empty_batch: boolean;
    checkpoint_advanced: boolean;
  };
  oracle: {
    successful_empty: boolean;
    frontier_advanced: boolean;
    unavailable_may_advance: boolean;
    partial_batch_may_advance: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function emptyErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "empty-success-requires-complete-accepted-batch") errors.push("unexpected example id");
  if (example.job.result !== "success") errors.push("accepted empty job lost success");
  if (!example.job.empty_batch) errors.push("empty batch dropped");
  if (!example.job.batch_complete) errors.push("incomplete batch labeled complete");
  if (!example.job.batch_accepted) errors.push("unaccepted batch labeled accepted");
  if (example.job.input_admission_refs.length !== 0) errors.push("empty batch still has admissions");
  if (!example.job.checkpoint_advanced) errors.push("complete accepted empty batch did not advance");
  if (example.unavailable.result !== "unavailable") errors.push("unavailable sibling drifted");
  if (example.unavailable.empty_batch) errors.push("unavailable sibling labeled empty");
  if (example.unavailable.checkpoint_advanced) errors.push("unavailable sibling advanced");
  if (!example.oracle.successful_empty) errors.push("complete accepted empty lost success");
  if (!example.oracle.frontier_advanced) errors.push("complete accepted empty did not advance the frontier");
  if (example.oracle.unavailable_may_advance) errors.push("unavailable may advance the frontier");
  if (example.oracle.partial_batch_may_advance) errors.push("partial batch may advance the frontier");
  return errors;
}

test("only a complete accepted empty batch may advance as empty success", () => {
  expect(emptyErrors(load())).toEqual([]);
});

test("unavailable, partial, or unaccepted empty advance fail", () => {
  const example = load();
  expect(emptyErrors(example)).toEqual([]);
  expect(
    emptyErrors({
      ...example,
      unavailable: { ...example.unavailable, empty_batch: true, checkpoint_advanced: true },
      oracle: { ...example.oracle, unavailable_may_advance: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    emptyErrors({
      ...example,
      job: { ...example.job, batch_complete: false, checkpoint_advanced: true },
      oracle: { ...example.oracle, partial_batch_may_advance: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    emptyErrors({
      ...example,
      job: { ...example.job, batch_accepted: false, checkpoint_advanced: false },
      oracle: { ...example.oracle, successful_empty: false, frontier_advanced: false },
    }).length,
  ).toBeGreaterThan(0);
});
