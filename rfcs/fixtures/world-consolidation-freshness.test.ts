/** Design-only check that a later deadline change is not served as current. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-freshness-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  summary: { deadline_value: string };
  later_change: { before_worker: boolean; deadline_value: string };
  read: {
    accounts_for_change: boolean;
    declares_freshness_gap: boolean;
    returns_old_deadline_as_current: boolean;
  };
  oracle: {
    stale_deadline_current: boolean;
    freshness_honest: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function freshnessErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "stale-deadline-is-not-current") errors.push("unexpected example id");
  if (!example.later_change.before_worker) errors.push("later change was not before the worker");
  if (example.later_change.deadline_value === example.summary.deadline_value) {
    errors.push("deadline change was lost");
  }
  if (example.read.returns_old_deadline_as_current) errors.push("old deadline served as current");
  if (!example.read.accounts_for_change && !example.read.declares_freshness_gap) {
    errors.push("read neither accounts for the change nor declares a freshness gap");
  }
  if (example.oracle.stale_deadline_current) errors.push("oracle served the stale deadline");
  if (!example.oracle.freshness_honest) errors.push("oracle freshness was dishonest");
  return errors;
}

test("a later deadline change is not returned as the old current value", () => {
  expect(freshnessErrors(load())).toEqual([]);
});

test("serving the pre-change deadline as current fails", () => {
  const example = load();
  expect(freshnessErrors(example)).toEqual([]);
  expect(
    freshnessErrors({
      ...example,
      read: {
        accounts_for_change: false,
        declares_freshness_gap: false,
        returns_old_deadline_as_current: true,
      },
      oracle: { stale_deadline_current: true, freshness_honest: false },
    }).length,
  ).toBeGreaterThan(0);
});
