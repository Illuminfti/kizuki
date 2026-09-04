import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../util/validate";
import { DEFAULT_SERVE_CONFIG, type ServeConfig } from "./types";

export function serveConfigPath(vaultPath: string): string {
  return join(vaultPath, ".kizuki", "serve.toml");
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * A configured model is a non-empty `[ports.llm] model` that is not `none`.
 * Absence stays off: doctor must not infer a model from a leftover receipt.
 * The label is `<port_id>:<model>` and, when `base_url` names a host,
 * `<port_id>:<model>@<host>` per RFC 0002 §12.1 — the same string a bound
 * `kizuki.llm/v1` port reports as its own `model_ref`. This reads the same
 * `[ports.llm]` table `loadLlmPortSelection` binds a real port from, so the
 * two can never name a different model.
 */
export function loadConfiguredModelRef(vaultPath: string): string | null {
  const selection = loadLlmPortSelection(vaultPath);
  if (selection === null) return null;
  const model = selection.config["model"];
  if (typeof model !== "string" || model.length === 0 || model === "none") {
    return null;
  }
  const baseUrl = selection.config["base_url"];
  let host: string | null = null;
  if (typeof baseUrl === "string") {
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      host = null;
    }
  }
  return host === null ? `${selection.id}:${model}` : `${selection.id}:${model}@${host}`;
}

export interface ConfiguredLlmPort {
  readonly id: string;
  /** The raw `[ports.llm]` table minus `id`, unredacted, for binding the real port. */
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * The full `[ports.llm]` selection, unredacted, for a caller that binds the
 * real `kizuki.llm/v1` port. Absence, `"kizuki.llm.none"`, or an empty
 * table all mean no model is configured — the same floor
 * `loadConfiguredModelRef` reads, kept in one parser so the two never drift.
 */
export function loadLlmPortSelection(vaultPath: string): ConfiguredLlmPort | null {
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
  const raw = ports["llm"];
  if (typeof raw === "string") {
    return raw.length === 0 || raw === "kizuki.llm.none" ? null : { id: raw, config: {} };
  }
  if (!isPlainObject(raw)) return null;
  const id =
    typeof raw["id"] === "string" && raw["id"].length > 0
      ? raw["id"]
      : "kizuki.llm.openai-compatible";
  if (id === "kizuki.llm.none") return null;
  const config: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (field !== "id") config[field] = value;
  }
  return { id, config };
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
  };
}
