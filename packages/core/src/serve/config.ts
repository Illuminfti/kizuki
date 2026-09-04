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
