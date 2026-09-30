import { expect, test } from "bun:test";
import { runEvaluation, renderMarkdown } from "./run";
import { scoreObservation } from "./score";
import { persona } from "./persona";

test("small synthetic persona is measured through four surfaces for two principals", async () => {
  const report = await runEvaluation({ size: "small" });
  expect(report.schema).toBe("kizuki.fresh-agent-eval/v1");
  expect(report.summaries).toHaveLength(8);
  expect(report.questions.length).toBeGreaterThanOrEqual(13);
  expect(report.rows).toHaveLength(report.questions.length * 8);
  expect(report.build.imports.every(receipt => receipt.repeat_stored === 0)).toBe(true);
  expect(report.build.extraction.reduce((total, pass) => total + pass.claims, 0)).toBeGreaterThan(0);
  expect(report.build).toMatchObject({ propose: "stored", correct: "committed" });
  expect(report.facts).toEqual(persona("small").facts);
  expect(report.questions).toEqual(persona("small").questions);
  expect(renderMarkdown(report)).toContain("| scoped_agent | world_view |");
  for (const summary of report.summaries) {
    expect(summary.leak_count).toBe(0);
    expect(summary.tokens_used).toBeGreaterThan(0);
    expect(summary.failures).toBe(0);
  }
  expect(report.summaries.some(row => row.recalled > 0)).toBe(true);
  for (const [index, sample] of report.observations.entries()) {
    const question = report.questions.find(item => item.id === sample.question_id)!;
    expect(scoreObservation(report.facts, question, sample.principal, sample.surface, sample.observation)).toEqual(report.rows[index]!);
  }
});
