import { openLedger } from "../../src/ledger/db";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";
import { expect, test } from "bun:test";
import { validateQuestionCard, type QuestionCard } from "../../src/contracts/question-card";
import { serveCorrect } from "../../src/serving/correct";
import { serveWorldView } from "../../src/serving/world-view";
import { questionFixture } from "../helpers/question-fixture";

test("Question historical snapshots retain the earlier lifecycle while current reads reflect owner correction", async () => {
  const at = "2030-01-09T00:00:00.000Z", db = openLedger(":memory:");
  db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(at);
  const f = await questionFixture(db, { model: EMPTY_SUMMARY_MODEL });
  try {
    await completeEmptyWorldSummaries(db, f.ctx.vaultPath, () => at);
    const input = { operation: "question", question: f.questionRef, valid: { kind: "all" }, knownAt: { kind: "time", at } };
    const before = serveWorldView(f.ctx, input).data;
    if (!("result" in before) || before.result.status !== "current" || !("kind" in before.result.view)) throw new Error("historical Question view missing");
    const old = before.result.data as QuestionCard;
    expect(old.knownAt.kind).toBe("snapshot");
    expect(old.lifecycle.status).toBe("open");
    expect(serveWorldView(f.ctx, { ...input, priorView: before.result.view }).data).toMatchObject({ result: { status: "unchanged" } });
    await serveCorrect(f.ctx, { statement: "I mark this question abandoned.", target: { world_claim: f.readQuestion().statusEvidence[0]!.claim },
      mode: "replace_object", object: { kind: "vocabulary", id: "question/abandoned" } });
    expect(f.readQuestion().lifecycle.status).toBe("abandoned");
    const retained = serveWorldView(f.ctx, { ...input, knownAt: old.knownAt }).data;
    expect(retained).toMatchObject({ result: { data: { lifecycle: { status: "open" }, knownAt: old.knownAt } } });
  } finally { f.dispose(); db.close(); }
}, 120_000);

test("Question payload and query grammars refuse extra keys, fabricated understanding and null selectors", async () => {
  const f = await questionFixture();
  try {
    const card = f.readQuestion();
    expect(validateQuestionCard(card).ok).toBe(true);
    for (const bad of [{ ...card, importance: 1 }, { ...card, understanding: "mastered" },
      { ...card, lifecycle: { ...card.lifecycle, extra: 1 } },
      { ...card, lifecycle: { status: { toString: () => "open" }, grounds: [] } },
      { ...card, answers: Array(257).fill(card.texts[0]) }]) expect(validateQuestionCard(bad).ok).toBe(false);
    for (const operation of ["find_questions", "frontier"]) for (const selector of ["label", "cursor", "about"])
      expect(() => serveWorldView(f.ctx, { operation, [selector]: null })).toThrow();
  } finally { f.dispose(); }
}, 120_000);
