import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeAtomicFile } from "../atomic-file";
import type { EstateErrorClass } from "./estate";

export const PARITY_RECEIPT_SCHEMA = "kizuki.parity-receipt/v1";
export const PARITY_RECEIPTS_DIR = join(".kizuki", "receipts", "parity");

export type KizukiErrorClass = "context_incomplete" | "kizuki_error";
export type ParityVerdict = "met" | "below_threshold" | "not_measured";

export interface SideReceipt<ErrorClass extends string> {
  status: "ok" | "error";
  error_class: ErrorClass | null;
  latency_ms: number;
  count: number;
}

export interface QueryReceipt {
  index: number;
  query_hash: string;
  kizuki: SideReceipt<KizukiErrorClass> & { degraded: string[] };
  estate: SideReceipt<EstateErrorClass> & { exit_code: number | null };
  overlap: {
    comparable: boolean;
    shared: number;
    kizuki_count: number;
    estate_count: number;
    ratio: number | null;
    /** Hashed keys of returned sources the other stack did not return, at most k each. */
    kizuki_only: string[];
    estate_only: string[];
  };
}

export interface ParityReceipt {
  schema: typeof PARITY_RECEIPT_SCHEMA;
  run_id: string;
  started_at: string;
  finished_at: string;
  config: {
    query_count: number;
    k: number;
    timeout_ms: number;
    min_overlap: number;
    estate_command_hash: string;
  };
  queries: QueryReceipt[];
  summary: {
    queries: number;
    compared: number;
    mean_overlap: number | null;
    verdict: ParityVerdict;
    kizuki_failures: number;
    estate_failures: number;
    exit_code: number;
  };
}

function digest(domain: string, text: string): string {
  return createHash("sha256").update(`kizuki.parity/v1:${domain}\0${text}`).digest("hex");
}

/** Full digest: a stable per-query id across runs. The text itself is never stored. */
export const queryHash = (query: string): string => digest("query", query);
/** Short digest of one source key, enough to tell diffs apart across runs. */
export const sourceHash = (key: string): string => digest("source", key).slice(0, 16);
export const commandHash = (argv: readonly string[]): string => digest("command", argv.join("\0"));

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * `kizuki` holds the source keys of each returned chunk, best first; `estate` holds the stack's keys.
 * A stack key is shared when any Kizuki chunk carries it. Overlap is the share of the stack's
 * keys that Kizuki also returned, so the existing stack is the baseline being matched.
 */
export function compareSources(
  kizuki: readonly (readonly string[])[],
  estate: readonly string[],
  comparable: boolean,
): QueryReceipt["overlap"] {
  const usable = comparable && estate.length > 0;
  const base = { kizuki_count: kizuki.length, estate_count: estate.length };
  if (!usable) return { ...base, comparable: false, shared: 0, ratio: null, kizuki_only: [], estate_only: [] };
  const kizukiKeys = new Set(kizuki.flat());
  const estateKeys = new Set(estate);
  const shared = estate.filter((key) => kizukiKeys.has(key)).length;
  return {
    ...base,
    comparable: true,
    shared,
    ratio: round(shared / estate.length),
    kizuki_only: kizuki.filter((chunk) => !chunk.some((key) => estateKeys.has(key))).map((chunk) => sourceHash(chunk[0] ?? "")),
    estate_only: estate.filter((key) => !kizukiKeys.has(key)).map(sourceHash),
  };
}

export function summarize(
  queries: readonly QueryReceipt[],
  minOverlap: number,
): Omit<ParityReceipt["summary"], "exit_code"> {
  const ratios = queries.flatMap((entry) => (entry.overlap.ratio === null ? [] : [entry.overlap.ratio]));
  const mean = ratios.length === 0 ? null : round(ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length);
  return {
    queries: queries.length,
    compared: ratios.length,
    mean_overlap: mean,
    verdict: mean === null ? "not_measured" : mean >= minOverlap ? "met" : "below_threshold",
    kizuki_failures: queries.filter((entry) => entry.kizuki.status === "error").length,
    estate_failures: queries.filter((entry) => entry.estate.status === "error").length,
  };
}

/** Writes `<vault>/.kizuki/receipts/parity/<run id>.json` privately and returns its vault-relative path. */
export function writeParityReceipt(vaultPath: string, receipt: ParityReceipt): string {
  const relative = join(PARITY_RECEIPTS_DIR, `${receipt.run_id}.json`);
  writeAtomicFile(join(vaultPath, relative), `${JSON.stringify(receipt, null, 2)}\n`);
  return relative;
}
