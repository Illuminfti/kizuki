/** Design-only check that Cue dismissal does not change factual authority. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-cue-dismissal-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  candidate: {
    id: string;
    purpose: string;
    claim_confidence: number;
    claim_authority: string;
  };
  dismissal: {
    candidate_ref: string;
    purpose: string;
    suppresses_same_candidate: boolean;
    retracts_claim: boolean;
    changes_confidence: boolean;
    changes_authority: boolean;
    grants_other_channel_delivery: boolean;
    grants_execution: boolean;
    widens_suppression_scope: boolean;
  };
  oracle: {
    claim_confidence_after: number;
    claim_authority_after: string;
    attention_suppressed: boolean;
    canon_gated: boolean;
    execution_granted: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function dismissalErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "cue-dismissal-preserves-fact") errors.push("unexpected example id");
  if (example.dismissal.candidate_ref !== example.candidate.id) errors.push("dismissal left its candidate");
  if (example.dismissal.purpose !== example.candidate.purpose) errors.push("dismissal left its purpose");
  if (!example.dismissal.suppresses_same_candidate) errors.push("same-candidate suppression lost");
  if (example.dismissal.retracts_claim) errors.push("dismissal retracts the claim");
  if (example.dismissal.changes_confidence) errors.push("dismissal changes confidence");
  if (example.dismissal.changes_authority) errors.push("dismissal changes authority");
  if (example.dismissal.grants_other_channel_delivery) errors.push("dismissal grants another channel");
  if (example.dismissal.grants_execution) errors.push("dismissal grants execution");
  if (example.dismissal.widens_suppression_scope) errors.push("dismissal widens suppression");
  if (example.oracle.claim_confidence_after !== example.candidate.claim_confidence) {
    errors.push("claim confidence changed after dismissal");
  }
  if (example.oracle.claim_authority_after !== example.candidate.claim_authority) {
    errors.push("claim authority changed after dismissal");
  }
  if (!example.oracle.attention_suppressed) errors.push("attention suppression missing");
  if (example.oracle.canon_gated) errors.push("Cue decision gates canon");
  if (example.oracle.execution_granted) errors.push("Cue decision grants execution");
  return errors;
}

test("dismissal suppresses the candidate without changing the claim", () => {
  expect(dismissalErrors(load())).toEqual([]);
});

test("retraction, confidence bump, wider scope, or execution grant fail", () => {
  const example = load();
  expect(dismissalErrors(example)).toEqual([]);
  expect(
    dismissalErrors({
      ...example,
      dismissal: { ...example.dismissal, retracts_claim: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    dismissalErrors({
      ...example,
      oracle: { ...example.oracle, claim_confidence_after: 0.8 },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    dismissalErrors({
      ...example,
      dismissal: { ...example.dismissal, widens_suppression_scope: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    dismissalErrors({
      ...example,
      dismissal: { ...example.dismissal, grants_execution: true },
      oracle: { ...example.oracle, execution_granted: true },
    }).length,
  ).toBeGreaterThan(0);
});
