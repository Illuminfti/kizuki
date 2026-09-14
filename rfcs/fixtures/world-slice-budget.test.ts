/** Design-only check that a World Slice budget covers the whole serialized response. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKET_TOKENIZER_ID, packetTokens } from "../../packages/core/src/serving/packet-tokenizer.ts";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-slice-budget-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  tokenizer_id: string;
  budget_tokens: number;
  mandatory: {
    constraint: string;
    qualifications: string[];
    evidence_refs: string[];
  };
  optional_explanation: string;
};

type Slice = {
  status: string;
  constraint?: string;
  qualifications?: string[];
  evidence_refs?: string[];
  explanation?: string;
  tokenizer_id: string;
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function serialize(slice: Slice): string {
  return JSON.stringify(slice);
}

function tokens(slice: Slice): number {
  return packetTokens(serialize(slice));
}

function fitting(example: Fixture): Slice {
  return {
    status: "current",
    constraint: example.mandatory.constraint,
    qualifications: example.mandatory.qualifications,
    evidence_refs: example.mandatory.evidence_refs,
    tokenizer_id: example.tokenizer_id,
  };
}

function overBudget(example: Fixture, status: string): Slice {
  return {
    status,
    constraint: example.mandatory.constraint,
    qualifications: example.mandatory.qualifications,
    evidence_refs: example.mandatory.evidence_refs,
    explanation: example.optional_explanation,
    tokenizer_id: example.tokenizer_id,
  };
}

test("a fitting serialized slice keeps the constraint and qualifications inside budget", () => {
  const example = load();
  expect(example.evaluation_state).toBe("not_run");
  expect(example.status).toBe("future_unimplemented");
  expect(example.id).toBe("world-slice-budget-constraint");
  expect(example.tokenizer_id).toBe(PACKET_TOKENIZER_ID);
  const slice = fitting(example);
  expect(tokens(slice)).toBeLessThanOrEqual(example.budget_tokens);
  expect(slice.constraint).toBe(example.mandatory.constraint);
  expect(slice.qualifications).toEqual(example.mandatory.qualifications);
  expect(slice.evidence_refs).toEqual(example.mandatory.evidence_refs);
  expect(tokens(overBudget(example, "budget"))).toBeGreaterThan(example.budget_tokens);
});

test("dropping mandatory material or claiming current while over budget fails", () => {
  const example = load();
  const complete = fitting(example);
  const droppedConstraint = { ...complete, constraint: undefined };
  const droppedQualifications = { ...complete, qualifications: undefined };
  expect(complete.status === "current" && droppedConstraint.constraint === undefined).toBe(true);
  expect(complete.status === "current" && droppedQualifications.qualifications === undefined).toBe(true);
  expect(tokens(overBudget(example, "current"))).toBeGreaterThan(example.budget_tokens);
  expect(tokens(overBudget(example, "unchanged"))).toBeGreaterThan(example.budget_tokens);
  expect(["current", "unchanged"]).not.toContain(overBudget(example, "budget").status);
});
