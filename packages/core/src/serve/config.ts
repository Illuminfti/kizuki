import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../util/validate";
import {
  DEFAULT_EXTRACTION_CONFIG,
  DEFAULT_RAILS,
  DEFAULT_SERVE_CONFIG,
  EMBED_BACKFILL_IDLE_PERIOD_S,
  CONNECTOR_DRAIN_BOUNDS,
  EXTRACTION_BOUNDS,
  SYNC_PERIOD_BOUNDS,
  type ExtractionConfig,
  type ServeConfig,
} from "./types";

export function serveConfigPath(vaultPath: string): string {
  return join(vaultPath, ".kizuki", "serve.toml");
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function extraction(table: Record<string, unknown>): ExtractionConfig {
  const bounded = (key: keyof ExtractionConfig): number =>
    integer(table[key], DEFAULT_EXTRACTION_CONFIG[key], EXTRACTION_BOUNDS[key].min, EXTRACTION_BOUNDS[key].max);
  return {
    max_calls_per_pass: bounded("max_calls_per_pass"),
    records_per_request: bounded("records_per_request"),
    max_input_tokens: bounded("max_input_tokens"),
    max_output_tokens: bounded("max_output_tokens"),
    max_pass_seconds: bounded("max_pass_seconds"),
    max_calls_per_day: bounded("max_calls_per_day"),
    max_output_tokens_per_day: bounded("max_output_tokens_per_day"),
  };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * A configured model is a non-empty `[ports.llm] model` that is not `none`.
 * Absence stays off: doctor must not infer a model from a leftover receipt.
 * The value is `port:model` without the endpoint host, so it says that a model
 * is configured but is not the reference the port stamps on run receipts; the
 * host that builds the port supplies that one (`configured_model_ref`).
 */
export function loadConfiguredModelRef(vaultPath: string): string | null {
  const path = serveConfigPath(vaultPath);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const ports = isPlainObject(parsed["ports"]) ? parsed["ports"] : {};
  const llm = isPlainObject(ports["llm"]) ? ports["llm"] : {};
  const model = llm["model"];
  if (typeof model !== "string" || model.length === 0 || model === "none") {
    return null;
  }
  const port = typeof llm["id"] === "string" && llm["id"].length > 0
    ? llm["id"]
    : "kizuki.llm.openai-compatible";
  return `${port}:${model}`;
}

/** Embedding port ids a vault may select; the host binds exactly these. */
export const EMBEDDING_PORT_IDS: readonly string[] = ["kizuki.embedding.none", "kizuki.embedding.gguf"];
const EMBEDDING_CONFIG_BYTES = 65_536;

/** The vault's `[ports] embedding` selection. `off` covers absence and `kizuki.embedding.none`. */
export type EmbeddingSelection =
  | { readonly state: "off" | "configured"; readonly id: string; readonly config: Record<string, unknown> }
  | { readonly state: "invalid"; readonly message: string; readonly id?: string };

/**
 * The one reader of `[ports] embedding`, shared by the CLI's port binding, the
 * embed rail's period and doctor. It validates against the known ids, so a typo
 * is `invalid` here exactly where the host would refuse to bind it.
 */
export function loadEmbeddingSelection(vaultPath: string): EmbeddingSelection {
  const off: EmbeddingSelection = { state: "off", id: "kizuki.embedding.none", config: {} };
  const path = serveConfigPath(vaultPath);
  if (!existsSync(path)) return off;
  let parsed: unknown;
  try {
    if (statSync(path).size > EMBEDDING_CONFIG_BYTES) throw new Error("oversized config");
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    return { state: "invalid", message: "embedding configuration is unreadable" };
  }
  if (!isPlainObject(parsed)) return { state: "invalid", message: "embedding configuration is invalid" };
  const ports = parsed["ports"];
  if (ports === undefined) return off;
  if (!isPlainObject(ports)) return { state: "invalid", message: "ports must be a table" };
  const value = ports["embedding"];
  if (value === undefined) return off;
  const table = isPlainObject(value) ? value : { id: value };
  const id = table["id"];
  if (typeof id !== "string" || id.length === 0) return { state: "invalid", message: "embedding must select an id" };
  if (!EMBEDDING_PORT_IDS.includes(id)) return { state: "invalid", message: "unknown embedding port", id };
  const { id: _id, ...config } = table;
  return { state: id === "kizuki.embedding.none" ? "off" : "configured", id, config };
}

/** The embed-backfill period for this vault: its schedule default only while an embedding port is configured, else a long back-off. */
export function embedBackfillPeriod(vaultPath: string): number {
  return loadEmbeddingSelection(vaultPath).state === "configured"
    ? (DEFAULT_RAILS.find((spec) => spec.rail === "embed-backfill")?.period_s ?? EMBED_BACKFILL_IDLE_PERIOD_S)
    : EMBED_BACKFILL_IDLE_PERIOD_S;
}

export function loadServeConfig(vaultPath: string): ServeConfig {
  const path = serveConfigPath(vaultPath);
  if (!existsSync(path)) return { ...DEFAULT_SERVE_CONFIG };
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...DEFAULT_SERVE_CONFIG };
  }
  if (!isPlainObject(parsed)) return { ...DEFAULT_SERVE_CONFIG };
  const serve = isPlainObject(parsed["serve"]) ? parsed["serve"] : parsed;
  const budget = isPlainObject(parsed["budget"]) ? parsed["budget"] : {};
  const extract = isPlainObject(parsed["extraction"]) ? parsed["extraction"] : {};
  const host = text(serve["bind_host"], DEFAULT_SERVE_CONFIG.bind_host);
  return {
    memory_max: text(serve["memory_max"], DEFAULT_SERVE_CONFIG.memory_max),
    cpu_quota: text(serve["cpu_quota"], DEFAULT_SERVE_CONFIG.cpu_quota),
    nice: integer(serve["nice"], DEFAULT_SERVE_CONFIG.nice, 0, 19),
    brief_hour: integer(serve["brief_hour"], DEFAULT_SERVE_CONFIG.brief_hour, 0, 23),
    bind_host: host === "127.0.0.1" || host === "::1" ? host : "127.0.0.1",
    bind_port: integer(serve["bind_port"], DEFAULT_SERVE_CONFIG.bind_port, 0, 65535),
    http: serve["http"] === false ? false : DEFAULT_SERVE_CONFIG.http,
    canon_writes_per_run: integer(
      budget["canon_writes_per_run"],
      DEFAULT_SERVE_CONFIG.canon_writes_per_run,
      0,
      10_000,
    ),
    canon_writes_per_day: integer(
      budget["canon_writes_per_day"],
      DEFAULT_SERVE_CONFIG.canon_writes_per_day,
      0,
      100_000,
    ),
    journal_retention_days: integer(
      serve["journal_retention_days"],
      DEFAULT_SERVE_CONFIG.journal_retention_days,
      1,
      365,
    ),
    sync_period_s: integer(
      serve["sync_period_s"],
      DEFAULT_SERVE_CONFIG.sync_period_s,
      SYNC_PERIOD_BOUNDS.min,
      SYNC_PERIOD_BOUNDS.max,
    ),
    connector_drain_seconds: integer(
      serve["connector_drain_seconds"],
      DEFAULT_SERVE_CONFIG.connector_drain_seconds,
      CONNECTOR_DRAIN_BOUNDS.connector_drain_seconds.min,
      CONNECTOR_DRAIN_BOUNDS.connector_drain_seconds.max,
    ),
    connector_drain_batches: integer(
      serve["connector_drain_batches"],
      DEFAULT_SERVE_CONFIG.connector_drain_batches,
      CONNECTOR_DRAIN_BOUNDS.connector_drain_batches.min,
      CONNECTOR_DRAIN_BOUNDS.connector_drain_batches.max,
    ),
    extraction: extraction(extract),
  };
}
