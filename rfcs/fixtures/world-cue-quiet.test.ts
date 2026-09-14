/** Design-only check that volume is not urgency and quiet stays quiet. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-cue-quiet-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  candidate: {
    mention_count: number;
    material_change: boolean;
    actionable: boolean;
    no_action_needed: boolean;
  };
  delivery: {
    interrupt: boolean;
    quiet_reason: string;
    records_quiet_without_telemetry: boolean;
    volume_implies_urgency: boolean;
  };
  oracle: {
    interrupted: boolean;
    urgency_from_volume: boolean;
    quiet_recorded: boolean;
    telemetry_collected: boolean;
    fabricated_action: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function quietErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "volume-is-not-urgency") errors.push("unexpected example id");
  if (example.candidate.mention_count < 2) errors.push("volume example lost its mention count");
  if (example.candidate.material_change) errors.push("no-change candidate marked material");
  if (example.candidate.actionable) errors.push("no-action candidate marked actionable");
  if (!example.candidate.no_action_needed) errors.push("no-action-needed dropped");
  if (example.delivery.interrupt) errors.push("quiet candidate interrupted");
  if (example.delivery.quiet_reason !== "no_material_change") errors.push("quiet reason drifted");
  if (!example.delivery.records_quiet_without_telemetry) errors.push("quiet reason not recorded locally");
  if (example.delivery.volume_implies_urgency) errors.push("volume treated as urgency");
  if (example.oracle.interrupted) errors.push("oracle interrupted without a material change");
  if (example.oracle.urgency_from_volume) errors.push("urgency derived from volume");
  if (!example.oracle.quiet_recorded) errors.push("quiet stay unrecorded");
  if (example.oracle.telemetry_collected) errors.push("quiet path collected telemetry");
  if (example.oracle.fabricated_action) errors.push("no-action state fabricated an alert");
  return errors;
}

test("high volume without a material change stays quiet", () => {
  expect(quietErrors(load())).toEqual([]);
});

test("volume-as-urgency, interrupt, or telemetry fail", () => {
  const example = load();
  expect(quietErrors(example)).toEqual([]);
  expect(
    quietErrors({
      ...example,
      delivery: { ...example.delivery, interrupt: true, volume_implies_urgency: true },
      oracle: { ...example.oracle, interrupted: true, urgency_from_volume: true, fabricated_action: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    quietErrors({
      ...example,
      candidate: { ...example.candidate, material_change: true, actionable: true, no_action_needed: false },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    quietErrors({
      ...example,
      delivery: { ...example.delivery, records_quiet_without_telemetry: false },
      oracle: { ...example.oracle, quiet_recorded: false, telemetry_collected: true },
    }).length,
  ).toBeGreaterThan(0);
});
