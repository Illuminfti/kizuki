import { randomBytes } from "node:crypto";
import { askEstate } from "./estate";
import {
  PARITY_RECEIPT_SCHEMA,
  commandHash,
  compareSources,
  queryHash,
  summarize,
} from "./receipt";
import type { KizukiErrorClass, ParityReceipt, QueryReceipt } from "./receipt";

/** 0 met; 1 is the CLI's runtime error; 2 usage. */
export const PARITY_EXIT = { ok: 0, kizukiFailure: 1, estateFailure: 3, belowThreshold: 4 } as const;

export interface ParityConfig {
  queries: readonly string[];
  estate: readonly string[];
  k: number;
  timeoutMs: number;
  minOverlap: number;
}

export type KizukiAnswer =
  | { ok: true; chunks: string[][]; degraded: string[] }
  | { ok: false; errorClass: KizukiErrorClass };

/** Asks Kizuki for its top source keys per chunk, best first. */
export type KizukiRetrieve = (query: string) => Promise<KizukiAnswer>;

/** A kizuki failure outranks a failing stack, which outranks a parity miss: each hides the next. */
export function parityExitCode(summary: Omit<ParityReceipt["summary"], "exit_code">): number {
  if (summary.kizuki_failures > 0) return PARITY_EXIT.kizukiFailure;
  if (summary.estate_failures > 0) return PARITY_EXIT.estateFailure;
  return summary.verdict === "met" ? PARITY_EXIT.ok : PARITY_EXIT.belowThreshold;
}

export async function runParity(config: ParityConfig, retrieve: KizukiRetrieve): Promise<ParityReceipt> {
  const startedAt = new Date();
  const queries: QueryReceipt[] = [];
  for (const [index, query] of config.queries.entries()) {
    const kizukiStarted = performance.now();
    const kizuki = await retrieve(query);
    const kizukiLatency = Math.round(performance.now() - kizukiStarted);
    const estate = await askEstate(config.estate, query, { timeoutMs: config.timeoutMs, k: config.k });
    const chunks = kizuki.ok ? kizuki.chunks.slice(0, config.k) : [];
    queries.push({
      index,
      query_hash: queryHash(query),
      kizuki: {
        status: kizuki.ok ? "ok" : "error",
        error_class: kizuki.ok ? null : kizuki.errorClass,
        latency_ms: kizukiLatency,
        count: chunks.length,
        degraded: kizuki.ok ? kizuki.degraded : [],
      },
      estate: {
        status: estate.error === undefined ? "ok" : "error",
        error_class: estate.error?.class ?? null,
        exit_code: estate.error === undefined ? 0 : estate.error.exitCode,
        latency_ms: estate.latencyMs,
        count: estate.keys.length,
      },
      overlap: compareSources(chunks, estate.keys, kizuki.ok && estate.error === undefined),
    });
  }
  const summary = summarize(queries, config.minOverlap);
  return {
    schema: PARITY_RECEIPT_SCHEMA,
    run_id: `parity-${startedAt.toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z-${randomBytes(4).toString("hex")}`,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    config: {
      query_count: queries.length,
      k: config.k,
      timeout_ms: config.timeoutMs,
      min_overlap: config.minOverlap,
      estate_command_hash: commandHash(config.estate),
    },
    queries,
    summary: { ...summary, exit_code: parityExitCode(summary) },
  };
}
