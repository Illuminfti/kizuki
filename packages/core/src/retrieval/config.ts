import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PortError } from "../contracts/ports";
import { isPlainObject } from "../util/validate";

export interface ConfiguredRetrieval {
  id: string;
  config: Record<string, unknown>;
}

/** Shared selection for CLI, daemon and MCP; opening an engine is a host concern. */
export function loadConfiguredRetrieval(vaultPath: string): ConfiguredRetrieval {
  const path = join(vaultPath, ".kizuki", "serve.toml");
  const fallback = { id: "kizuki.retrieval.fts5", config: {} };
  if (!existsSync(path)) return fallback;
  let parsed: unknown;
  try {
    if (statSync(path).size > 65_536) throw new Error("oversized config");
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PortError("config_invalid", "retrieval configuration is unreadable", false);
  }
  if (!isPlainObject(parsed)) throw new PortError("config_invalid", "retrieval configuration is invalid", false);
  if (parsed["ports"] === undefined) return fallback;
  if (!isPlainObject(parsed["ports"])) throw new PortError("config_invalid", "ports must be a table", false);
  const value = parsed["ports"]["retrieval"];
  if (value === undefined) return fallback;
  const table = isPlainObject(value) ? value : { id: value };
  if (typeof table["id"] !== "string" || table["id"].length === 0) {
    throw new PortError("config_invalid", "retrieval must select an id", false);
  }
  const { id, ...config } = table;
  // Compatibility for the previously accepted configuration spelling. The
  // running port and receipts always identify the actual implementation.
  return { id: id === "kizuki.retrieval.pg" ? "kizuki.retrieval.embedded-pg" : id, config };
}
