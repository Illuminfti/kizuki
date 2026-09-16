import { expect, test } from "bun:test";
import { emptyRunTotals, type RunReceipt } from "../../src/serve/types";
import {
  embeddingThroughputFromReceipts,
  formatReembedRefusal,
  planFullReembed,
} from "../../src/retrieval/reembed";

function receipt(overrides: Partial<RunReceipt> & { run_id: string }): RunReceipt {
  return {
    ...emptyRunTotals(),
    rail: "embed-backfill",
    started_at: "2026-09-16T00:00:00.000Z",
    finished_at: "2026-09-16T00:00:10.000Z",
    status: "ok",
    stopped: null,
    ...overrides,
  };
}

test("identical or lexical spaces are not a full re-embed", () => {
  expect(planFullReembed({
    previousSpace: null, nextSpace: null, documents: 12, throughputDocsPerS: 2,
  })).toBeNull();
  expect(planFullReembed({
    previousSpace: "fixture:hash@8", nextSpace: "fixture:hash@8", documents: 12, throughputDocsPerS: 2,
  })).toBeNull();
  expect(planFullReembed({
    previousSpace: "fixture:hash@8", nextSpace: null, documents: 12, throughputDocsPerS: 2,
  })).toBeNull();
});

test("a space change is priced from doctor throughput", () => {
  const plan = planFullReembed({
    previousSpace: "fixture:old@8",
    nextSpace: "fixture:new@8",
    documents: 21,
    throughputDocsPerS: 2,
  });
  expect(plan).toEqual({
    kind: "full-re-embed",
    from: "fixture:old@8",
    to: "fixture:new@8",
    documents: 21,
    throughput_docs_per_s: 2,
    estimated_duration_s: 11,
  });
  expect(formatReembedRefusal(plan!)).toContain("requires --confirm");
  expect(formatReembedRefusal(plan!)).toContain("estimated_duration_s=11");
});

test("unmeasured throughput still requires confirmation and does not invent a duration", () => {
  const plan = planFullReembed({
    previousSpace: null,
    nextSpace: "fixture:new@8",
    documents: 8,
    throughputDocsPerS: null,
  });
  expect(plan).toMatchObject({
    kind: "full-re-embed",
    from: null,
    to: "fixture:new@8",
    estimated_duration_s: null,
    throughput_docs_per_s: null,
  });
  expect(formatReembedRefusal(plan!)).toContain("unmeasured");
  expect(embeddingThroughputFromReceipts([])).toBeNull();
  expect(embeddingThroughputFromReceipts([
    receipt({
      run_id: "failed",
      status: "failed",
      retrieval: { upserts: 40, removals: 0, pending_ops: 0, degraded: [] },
    }),
    receipt({
      run_id: "zero",
      retrieval: { upserts: 0, removals: 0, pending_ops: 0, degraded: [] },
    }),
  ])).toBeNull();
});

test("throughput is docs per wall-clock second from successful embed-backfill receipts", () => {
  expect(embeddingThroughputFromReceipts([
    receipt({
      run_id: "a",
      retrieval: { upserts: 10, removals: 0, pending_ops: 0, degraded: [] },
    }),
    receipt({
      run_id: "b",
      started_at: "2026-09-16T00:01:00.000Z",
      finished_at: "2026-09-16T00:01:10.000Z",
      retrieval: { upserts: 30, removals: 0, pending_ops: 0, degraded: [] },
    }),
  ])).toBe(2);
});
