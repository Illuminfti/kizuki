/** Design-only check that unavailable consolidation is not empty success. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-unavailable-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  job: {
    id: string;
    kind: string;
    result: string;
    empty_batch: boolean;
    checkpoint_advanced: boolean;
  };
  read: {
    after_new_evidence: boolean;
    view: string;
    fabricated_fresh_deadline: boolean;
    owner_correction_waiting: boolean;
  };
  oracle: {
    result: string;
    successful_empty: boolean;
    frontier_advanced: boolean;
    current_deadline_claimed: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function consolidationErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "unavailable-is-not-empty-success") errors.push("unexpected example id");
  if (example.job.result !== "unavailable") errors.push("job result left unavailable");
  if (example.job.empty_batch) errors.push("unavailable job labeled empty batch");
  if (example.job.checkpoint_advanced) errors.push("unavailable job advanced the checkpoint");
  if (!example.read.after_new_evidence) errors.push("new evidence before the job was dropped");
  if (example.read.view !== "pending_consolidation") errors.push("read claimed a verified current view");
  if (example.read.fabricated_fresh_deadline) errors.push("read invented a reconciled deadline");
  if (example.read.owner_correction_waiting) errors.push("owner correction queued behind consolidation");
  if (example.oracle.result !== "unavailable") errors.push("oracle result drifted");
  if (example.oracle.successful_empty) errors.push("unavailable relabeled successful empty consolidation");
  if (example.oracle.frontier_advanced) errors.push("successful frontier advanced without coverage");
  if (example.oracle.current_deadline_claimed) errors.push("stale deadline presented as current");
  return errors;
}

test("unavailable consolidation does not count as empty success", () => {
  expect(consolidationErrors(load())).toEqual([]);
});

test("empty-success, checkpoint advance, or fabricated freshness fail", () => {
  const example = load();
  expect(consolidationErrors(example)).toEqual([]);
  expect(
    consolidationErrors({
      ...example,
      job: { ...example.job, result: "success", empty_batch: true, checkpoint_advanced: true },
      oracle: { ...example.oracle, result: "success", successful_empty: true, frontier_advanced: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    consolidationErrors({
      ...example,
      job: { ...example.job, checkpoint_advanced: true },
      oracle: { ...example.oracle, frontier_advanced: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    consolidationErrors({
      ...example,
      read: { ...example.read, view: "current", fabricated_fresh_deadline: true },
      oracle: { ...example.oracle, current_deadline_claimed: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    consolidationErrors({
      ...example,
      read: { ...example.read, owner_correction_waiting: true },
    }).length,
  ).toBeGreaterThan(0);
});
