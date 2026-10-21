import { describe, expect, test } from "bun:test";
import { openLedger } from "../packages/core/src/ledger/db";
import { indexDocument } from "../packages/core/src/search/indexer";
import { toFtsQuery } from "../packages/core/src/search/query";
import { initSearch } from "../packages/core/src/search/schema";
import { MINIMUMS, evaluate, shortfalls, syntheticRanker } from "./retrieval-quality";
import { goldenQuestions, syntheticDocuments } from "./retrieval-quality-corpus";
import type { GoldenQuestion } from "./retrieval-quality-corpus";

describe("the golden set", () => {
  test("covers keyword, paraphrase, decision and unanswerable questions over a synthetic vault", () => {
    const questions = goldenQuestions();
    for (const kind of ["keyword", "paraphrase", "decision", "unanswerable"] as const) {
      expect(questions.filter((question) => question.kind === kind).length).toBeGreaterThanOrEqual(8);
    }
    const documents = new Set(syntheticDocuments().map((doc) => doc.docId));
    for (const question of questions) {
      for (const answer of question.answers) expect(documents.has(answer)).toBe(true);
      expect(question.kind === "unanswerable").toBe(question.answers.length === 0);
    }
  });
});

describe("the scorer", () => {
  const questions: GoldenQuestion[] = [
    { kind: "keyword", query: "first", answers: ["a"] },
    { kind: "keyword", query: "second", answers: ["a"] },
    { kind: "keyword", query: "missing", answers: ["a"] },
    { kind: "unanswerable", query: "nothing", answers: [] },
    { kind: "unanswerable", query: "noise", answers: [] },
  ];
  const ranked: Record<string, string[]> = {
    first: ["a", "b"],
    second: ["x", "y", "z", "b", "a"],
    missing: ["b"],
    nothing: [],
    noise: ["b"],
  };

  test("reports hit@k, mean reciprocal rank and abstention", () => {
    const report = evaluate((query) => ranked[query] ?? [], questions);
    expect(report.keyword).toMatchObject({ questions: 3, hitAt5: 2 / 3 });
    expect(report.keyword.hitAt1).toBeCloseTo(1 / 3);
    expect(report.keyword.mrr).toBeCloseTo((1 + 1 / 5 + 0) / 3);
    expect(report.unanswerable.abstained).toBe(0.5);
  });
});

describe("retrieval quality on the synthetic vault", () => {
  test("meets every pinned minimum", () => {
    const ranker = syntheticRanker();
    try { expect(shortfalls(evaluate(ranker))).toEqual([]); } finally { ranker.close(); }
  });

  test("pins every category", () => {
    expect(new Set(MINIMUMS.map(({ kind }) => kind))).toEqual(new Set(["keyword", "paraphrase", "decision", "unanswerable"]));
  });

  test("fails a ranker that ANDs every word of a question, as search did before relaxation", () => {
    const db = openLedger(":memory:");
    initSearch(db);
    for (const doc of syntheticDocuments()) indexDocument(db, doc);
    const literal = (query: string): string[] =>
      db
        .query<{ doc_id: string }, [string]>(
          "SELECT doc_id FROM search_docs WHERE search_docs MATCH ? ORDER BY bm25(search_docs, 0, 0, 4.0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0) LIMIT 20",
        )
        .all(toFtsQuery(query))
        .map((row) => row.doc_id);
    const failures = shortfalls(evaluate(literal));
    expect(failures.some((failure) => failure.startsWith("paraphrase"))).toBe(true);
    expect(failures.some((failure) => failure.startsWith("decision"))).toBe(true);
    db.close();
  });

  test("the command prints a report and exits zero when every minimum is met", async () => {
    const run = Bun.spawn(["bun", `${import.meta.dir}/retrieval-quality.ts`, "--json"], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { failures: string[]; report: Record<string, { questions: number }> };
    expect(parsed.failures).toEqual([]);
    expect(Object.keys(parsed.report)).toEqual(["keyword", "paraphrase", "decision", "unanswerable"]);
  }, 60_000);
});
