/** Design-only check that a copied AI answer is not independent corroboration. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-question-copy-design.json");

type Candidate = {
  id: string;
  kind: string;
  evidence_ref: string;
  independent_root: boolean;
  demonstrates_owner_understanding?: boolean;
  resolves_question?: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  question: {
    id: string;
    lifecycle: string;
    source_conversation_ref: string;
    survives_source_conversation: boolean;
  };
  candidates: Candidate[];
  understanding: {
    answer_available: boolean;
    owner_understanding: string;
    missing_practice_is_incompetence: boolean;
  };
  curiosity: {
    mention_count: number;
    frequency_implies_importance: boolean;
  };
  oracle: {
    lifecycle: string;
    independent_corroboration_count: number;
    copied_answer_is_independent_witness: boolean;
    resolved: boolean;
    owner_understood: boolean;
    curiosity_from_frequency: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function row(example: Fixture, id: string): Candidate {
  const found = example.candidates.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

function questionErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "copied-answer-is-not-corroboration") errors.push("unexpected example id");
  if (example.question.lifecycle !== "open") errors.push("question left the open lifecycle");
  if (!example.question.survives_source_conversation) errors.push("question died with its conversation");
  const copied = row(example, "c_copied_model");
  const partial = row(example, "c_partial_note");
  if (copied.kind !== "copied_model_answer") errors.push("copied answer kind drifted");
  if (copied.independent_root) errors.push("copied AI answer counted as an independent root");
  if (copied.demonstrates_owner_understanding) errors.push("copied answer treated as demonstrated learning");
  if (!partial.independent_root) errors.push("later partial evidence lost independent-root status");
  if (partial.resolves_question) errors.push("partial evidence resolved the question");
  if (!example.understanding.answer_available) errors.push("available answer marked missing");
  if (example.understanding.owner_understanding !== "unknown") {
    errors.push("owner understanding inferred from an available answer");
  }
  if (example.understanding.missing_practice_is_incompetence) {
    errors.push("missing practice diagnosed as incompetence");
  }
  if (example.curiosity.frequency_implies_importance) {
    errors.push("mention frequency treated as importance");
  }
  if (example.oracle.copied_answer_is_independent_witness) {
    errors.push("copied answer counted as another witness");
  }
  if (example.oracle.independent_corroboration_count !== 1) {
    errors.push("independent corroboration count drifted");
  }
  if (example.oracle.resolved) errors.push("open question marked resolved");
  if (example.oracle.owner_understood) errors.push("owner marked as having understood");
  if (example.oracle.curiosity_from_frequency) errors.push("curiosity derived from frequency");
  if (example.oracle.lifecycle !== example.question.lifecycle) errors.push("oracle lifecycle drifted");
  return errors;
}

test("a copied AI answer does not corroborate or prove understanding", () => {
  expect(questionErrors(load())).toEqual([]);
});

test("independent-root copy, inferred understanding, or frequency-as-curiosity fail", () => {
  const example = load();
  expect(questionErrors(example)).toEqual([]);
  const copied = row(example, "c_copied_model");
  const partial = row(example, "c_partial_note");
  expect(
    questionErrors({
      ...example,
      candidates: [{ ...copied, independent_root: true }, partial],
      oracle: { ...example.oracle, copied_answer_is_independent_witness: true, independent_corroboration_count: 2 },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    questionErrors({
      ...example,
      understanding: { ...example.understanding, owner_understanding: "demonstrated" },
      oracle: { ...example.oracle, owner_understood: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    questionErrors({
      ...example,
      curiosity: { ...example.curiosity, frequency_implies_importance: true },
      oracle: { ...example.oracle, curiosity_from_frequency: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    questionErrors({
      ...example,
      question: { ...example.question, lifecycle: "resolved" },
      oracle: { ...example.oracle, lifecycle: "resolved", resolved: true },
    }).length,
  ).toBeGreaterThan(0);
});
