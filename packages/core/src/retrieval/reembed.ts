import type { RunReceipt } from "../serve/types";

export interface ReembedPlan {
  readonly kind: "full-re-embed";
  readonly from: string | null;
  readonly to: string;
  readonly documents: number;
  readonly throughput_docs_per_s: number | null;
  readonly estimated_duration_s: number | null;
}

/** Space change is a full re-embed; lexical-only or identical spaces are not. */
export function planFullReembed(input: {
  previousSpace: string | null;
  nextSpace: string | null;
  documents: number;
  throughputDocsPerS: number | null;
}): ReembedPlan | null {
  if (input.nextSpace === null || input.nextSpace === input.previousSpace) return null;
  const throughput = input.throughputDocsPerS !== null
    && Number.isFinite(input.throughputDocsPerS)
    && input.throughputDocsPerS > 0
    ? input.throughputDocsPerS
    : null;
  return {
    kind: "full-re-embed",
    from: input.previousSpace,
    to: input.nextSpace,
    documents: input.documents,
    throughput_docs_per_s: throughput,
    estimated_duration_s: throughput === null ? null : Math.ceil(input.documents / throughput),
  };
}

/** Measured docs/s from successful embed-backfill receipts. Unmeasured is null, never invented. */
export function embeddingThroughputFromReceipts(receipts: readonly RunReceipt[]): number | null {
  let docs = 0;
  let ms = 0;
  for (const receipt of receipts) {
    if (receipt.rail !== "embed-backfill" || receipt.status !== "ok") continue;
    const upserts = receipt.retrieval.upserts;
    if (!Number.isInteger(upserts) || upserts <= 0) continue;
    const started = Date.parse(receipt.started_at);
    const finished = Date.parse(receipt.finished_at);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) continue;
    docs += upserts;
    ms += finished - started;
  }
  if (docs <= 0 || ms <= 0) return null;
  return docs / (ms / 1000);
}

export function formatReembedRefusal(plan: ReembedPlan): string {
  const duration = plan.estimated_duration_s === null ? "unmeasured" : String(plan.estimated_duration_s);
  const throughput = plan.throughput_docs_per_s === null
    ? "doctor has no measured embedding throughput"
    : `${plan.throughput_docs_per_s} docs/s`;
  return `full re-embed from ${plan.from ?? "none"} to ${plan.to} requires --confirm; estimated_duration_s=${duration} (${throughput})`;
}
