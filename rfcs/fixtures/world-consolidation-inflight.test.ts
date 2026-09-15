/** Design-only check that an in-flight correction beats a stale commit. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-inflight-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  job: { stale_commit: boolean };
  correction: { during_job: boolean; overwritten_by_stale_commit: boolean };
  oracle: {
    stale_commit_wins: boolean;
    correction_preserved: boolean;
    race_invented_current: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function inflightErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "inflight-correction-beats-stale-commit") errors.push("unexpected example id");
  if (!example.job.stale_commit) errors.push("stale commit marker dropped");
  if (!example.correction.during_job) errors.push("correction was not during the job");
  if (example.correction.overwritten_by_stale_commit) errors.push("stale commit overwrote the correction");
  if (example.oracle.stale_commit_wins) errors.push("oracle let the stale commit win");
  if (!example.oracle.correction_preserved) errors.push("oracle dropped the correction");
  if (example.oracle.race_invented_current) errors.push("oracle invented current state from a race");
  return errors;
}

test("an in-flight correction is not overwritten by a later stale commit", () => {
  expect(inflightErrors(load())).toEqual([]);
});

test("a stale commit winning the race fails", () => {
  const example = load();
  expect(inflightErrors(example)).toEqual([]);
  expect(
    inflightErrors({
      ...example,
      correction: { ...example.correction, overwritten_by_stale_commit: true },
      oracle: { stale_commit_wins: true, correction_preserved: false, race_invented_current: true },
    }).length,
  ).toBeGreaterThan(0);
});
