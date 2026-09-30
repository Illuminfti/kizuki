import { openLedger } from "../packages/core/src/ledger/db";
import { indexDocument } from "../packages/core/src/search/indexer";
import { searchResult } from "../packages/core/src/search/query";
import { initSearch } from "../packages/core/src/search/schema";
import {
  goldenQuestions,
  syntheticDocuments,
} from "./retrieval-quality-corpus";
import type { GoldenQuestion, QuestionKind } from "./retrieval-quality-corpus";

/**
 * Retrieval quality on a synthetic vault: how often the right document is
 * near the top of what a question returns, and whether an unanswerable
 * question returns nothing. Run it after a change to query parsing, ranking or
 * the index:
 *
 *   bun run eval:retrieval [--json]
 *
 * It exits 1 when a category falls under its minimum.
 */

const DEPTH = 20;

export interface Ranker {
  (query: string): string[];
}

export interface CategoryReport {
  questions: number;
  hitAt1: number;
  hitAt5: number;
  hitAt20: number;
  /** Mean reciprocal rank of the first answering document within the top 20. */
  mrr: number;
  /** Share of questions that returned nothing. Only unanswerable questions are scored on it. */
  abstained: number;
}

export type QualityReport = Record<QuestionKind, CategoryReport>;

export interface Minimum {
  kind: QuestionKind;
  metric: keyof Omit<CategoryReport, "questions">;
  at_least: number;
}

/** Pinned below what the current implementation scores, so a regression fails and noise does not. */
export const MINIMUMS: readonly Minimum[] = [
  { kind: "keyword", metric: "hitAt1", at_least: 0.75 },
  { kind: "keyword", metric: "hitAt5", at_least: 0.9 },
  { kind: "paraphrase", metric: "hitAt1", at_least: 0.6 },
  { kind: "paraphrase", metric: "hitAt5", at_least: 0.9 },
  { kind: "paraphrase", metric: "mrr", at_least: 0.75 },
  { kind: "decision", metric: "hitAt1", at_least: 0.9 },
  { kind: "decision", metric: "mrr", at_least: 0.9 },
  { kind: "unanswerable", metric: "abstained", at_least: 0.9 },
];

/** The search a caller gets: canon and ledger together, at the highest ceiling. */
export function syntheticRanker(): Ranker & { close(): void } {
  const db = openLedger(":memory:");
  initSearch(db);
  for (const doc of syntheticDocuments()) indexDocument(db, doc);
  const ranker: Ranker = (query) =>
    searchResult(db, query, {
      ceiling: "private",
      scope: "all",
      limit: DEPTH,
    }).hits.map((hit) => hit.doc_id);
  return Object.assign(ranker, { close: () => db.close() });
}

function score(
  question: GoldenQuestion,
  ranked: readonly string[],
): { rank: number | null; abstained: boolean } {
  const index = ranked.findIndex((id) => question.answers.includes(id));
  return {
    rank: index === -1 ? null : index + 1,
    abstained: ranked.length === 0,
  };
}

export function evaluate(
  ranker: Ranker,
  questions: readonly GoldenQuestion[] = goldenQuestions(),
): QualityReport {
  const kinds: QuestionKind[] = [
    "keyword",
    "paraphrase",
    "decision",
    "unanswerable",
  ];
  const report = {} as QualityReport;
  for (const kind of kinds) {
    const scored = questions
      .filter((question) => question.kind === kind)
      .map((question) => score(question, ranker(question.query)));
    const share = (count: number): number =>
      scored.length === 0 ? 0 : count / scored.length;
    const within = (depth: number): number =>
      scored.filter(({ rank }) => rank !== null && rank <= depth).length;
    report[kind] = {
      questions: scored.length,
      hitAt1: share(within(1)),
      hitAt5: share(within(5)),
      hitAt20: share(within(DEPTH)),
      mrr:
        scored.reduce(
          (sum, { rank }) => sum + (rank === null ? 0 : 1 / rank),
          0,
        ) /
          Math.max(1, scored.length),
      abstained: share(scored.filter(({ abstained }) => abstained).length),
    };
  }
  return report;
}

/** One line per pinned minimum the report does not meet. */
export function shortfalls(report: QualityReport): string[] {
  return MINIMUMS.filter(
    ({ kind, metric, at_least }) => report[kind][metric] < at_least,
  ).map(
    ({ kind, metric, at_least }) =>
      `${kind} ${metric} ${report[kind][metric].toFixed(2)} is under ${at_least.toFixed(2)}`,
  );
}

function table(report: QualityReport): string {
  const cell = (value: number): string => value.toFixed(2).padStart(6);
  const rows = (Object.keys(report) as QuestionKind[]).map((kind) => {
    const row = report[kind];
    return `${kind.padEnd(13)}${String(row.questions).padStart(4)}${cell(row.hitAt1)}${cell(row.hitAt5)}${cell(row.hitAt20)}${cell(row.mrr)}${cell(row.abstained)}`;
  });
  return [
    `${"kind".padEnd(13)}${"n".padStart(4)}${"hit@1".padStart(6)}${"hit@5".padStart(6)}${"hit@20".padStart(6)}${"mrr".padStart(6)}${"abstn".padStart(6)}`,
    ...rows,
  ].join("\n");
}

if (import.meta.main) {
  const ranker = syntheticRanker();
  let report: QualityReport;
  try { report = evaluate(ranker); } finally { ranker.close(); }
  const failures = shortfalls(report);
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify({ report, failures })}\n`
      : `${table(report)}\n`,
  );
  for (const failure of failures)
    process.stderr.write(`retrieval quality: ${failure}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}
