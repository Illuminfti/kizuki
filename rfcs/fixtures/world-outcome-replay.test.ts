/** Design-only check that replayed receipts do not invent extra results. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-outcome-replay-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  receipts: {
    first: { idempotency_key: string; logical_result_id: string; invented_success: boolean };
    replay: { idempotency_key: string; logical_result_id: string; duplicate: boolean; invented_success: boolean };
    unknown: { unknown: boolean; invented_success: boolean; retry_safe: boolean };
  };
  oracle: {
    logical_results: number;
    replay_creates_second_result: boolean;
    unknown_counted_success: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function replayErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "duplicate-receipt-is-one-result") errors.push("unexpected example id");
  if (example.receipts.first.idempotency_key !== example.receipts.replay.idempotency_key) {
    errors.push("replay lost the idempotency key");
  }
  if (example.receipts.first.logical_result_id !== example.receipts.replay.logical_result_id) {
    errors.push("replay created a second logical result");
  }
  if (!example.receipts.replay.duplicate) errors.push("replay not marked duplicate");
  if (example.receipts.first.invented_success || example.receipts.replay.invented_success) {
    errors.push("replay invented success");
  }
  if (!example.receipts.unknown.unknown) errors.push("unknown outcome dropped");
  if (example.receipts.unknown.invented_success) errors.push("unknown invented as success");
  if (!example.receipts.unknown.retry_safe) errors.push("unknown is not retry-safe");
  if (example.oracle.logical_results !== 1) errors.push("oracle counted extra logical results");
  if (example.oracle.replay_creates_second_result) errors.push("oracle split the replay");
  if (example.oracle.unknown_counted_success) errors.push("oracle counted unknown as success");
  return errors;
}

test("duplicate receipts preserve one logical result", () => {
  expect(replayErrors(load())).toEqual([]);
});

test("splitting a replay or inventing success from unknown fails", () => {
  const example = load();
  expect(replayErrors(example)).toEqual([]);
  expect(
    replayErrors({
      ...example,
      receipts: {
        ...example.receipts,
        replay: { ...example.receipts.replay, logical_result_id: "x_result_2", duplicate: false },
      },
      oracle: { ...example.oracle, logical_results: 2, replay_creates_second_result: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    replayErrors({
      ...example,
      receipts: {
        ...example.receipts,
        unknown: { ...example.receipts.unknown, invented_success: true, retry_safe: false },
      },
      oracle: { ...example.oracle, unknown_counted_success: true },
    }).length,
  ).toBeGreaterThan(0);
});
