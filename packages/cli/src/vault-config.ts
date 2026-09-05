import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPlainObject,
  loadConfiguredModelRef,
  loadConfiguredRetrieval,
  loadServeConfig,
  type ServeConfig,
} from "@kizuki/core";

export const VAULT_CONFIG_PATH = ".kizuki/serve.toml";

const PORT_KEYS = ["retrieval", "embedding", "llm", "notifier", "surface"] as const;
type PortKey = (typeof PORT_KEYS)[number];

const KNOWN_PORT_IDS: Readonly<Record<PortKey, readonly string[]>> = {
  retrieval: ["kizuki.retrieval.fts5", "kizuki.retrieval.embedded-pg", "kizuki.retrieval.pg"],
  embedding: ["kizuki.embedding.none", "kizuki.embedding.gguf"],
  llm: [
    "kizuki.llm.none",
    "kizuki.llm.openai-compatible",
    "kizuki.llm.gguf",
  ],
  notifier: [],
  surface: ["kizuki.surface.cli", "kizuki.surface.mcp-stdio"],
};

export interface VaultPorts {
  retrieval: string;
  embedding: string;
  llm: string;
  notifier: string[];
  surface: string[];
  extra: Record<string, Record<string, unknown>>;
}

export interface VaultSensitivity {
  default: "public" | "personal" | "private";
}

export interface VaultConfig {
  path: string;
  present: boolean;
  ports: VaultPorts;
  serve: ServeConfig;
  model_ref: string | null;
  sensitivity: VaultSensitivity;
}

export class VaultConfigError extends Error {
  override name = "VaultConfigError";
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

function redactValue(key: string, value: unknown): unknown {
  if (key === "secret_ref" || key.endsWith("_key") || key.includes("token")) {
    return typeof value === "string" && value.length > 0 ? "redacted" : value;
  }
  return value;
}

function redactTable(table: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(table)) {
    out[key] = isPlainObject(value)
      ? redactTable(value)
      : redactValue(key, value);
  }
  return out;
}

function assertKnownPort(kind: PortKey, id: string, path: string): void {
  const allowed = KNOWN_PORT_IDS[kind];
  if (allowed.length === 0) return;
  if (!allowed.includes(id)) {
    throw new VaultConfigError(`${path}: unknown ${kind} port ${id}`);
  }
}

export function vaultConfigPath(vaultPath: string): string {
  return join(vaultPath, VAULT_CONFIG_PATH);
}

export function loadVaultConfig(vaultPath: string): VaultConfig {
  const path = vaultConfigPath(vaultPath);
  const serve = loadServeConfig(vaultPath);
  const model_ref = loadConfiguredModelRef(vaultPath);
  const ports: VaultPorts = {
    retrieval: "kizuki.retrieval.fts5",
    embedding: "kizuki.embedding.none",
    llm: model_ref === null ? "kizuki.llm.none" : "kizuki.llm.openai-compatible",
    notifier: [],
    surface: ["kizuki.surface.cli"],
    extra: Object.create(null) as Record<string, Record<string, unknown>>,
  };
  ports.retrieval = loadConfiguredRetrieval(vaultPath).id;
  const sensitivity: VaultSensitivity = { default: "private" };

  if (!existsSync(path)) {
    return { path, present: false, ports, serve, model_ref, sensitivity };
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    throw new VaultConfigError(`${path}: invalid TOML`);
  }
  if (!isPlainObject(parsed)) {
    throw new VaultConfigError(`${path}: config must be a table`);
  }

  const root = parsed;
  if ("ports" in root) {
    const table = root["ports"];
    if (!isPlainObject(table)) {
      throw new VaultConfigError(`${path}: [ports] must be a table`);
    }
    for (const key of Object.keys(table)) {
      if (
        !(PORT_KEYS as readonly string[]).includes(key) &&
        !key.startsWith("retrieval") &&
        !key.startsWith("embedding") &&
        !key.startsWith("llm") &&
        !key.startsWith("notifier") &&
        !key.startsWith("surface")
      ) {
        throw new VaultConfigError(`${path}: unknown ports key ${key}`);
      }
    }
    if (typeof table["retrieval"] === "string") {
      assertKnownPort("retrieval", table["retrieval"], path);
      ports.retrieval = loadConfiguredRetrieval(vaultPath).id;
    }
    if (typeof table["embedding"] === "string") {
      assertKnownPort("embedding", table["embedding"], path);
      ports.embedding = table["embedding"];
    }
    if (typeof table["llm"] === "string") {
      assertKnownPort("llm", table["llm"], path);
      ports.llm = table["llm"];
    } else if (isPlainObject(table["llm"]) && typeof table["llm"]["id"] === "string") {
      assertKnownPort("llm", table["llm"]["id"], path);
      ports.llm = table["llm"]["id"];
      ports.extra["llm"] = redactTable(table["llm"]);
    }
    ports.notifier = asStringList(table["notifier"], ports.notifier);
    ports.surface = asStringList(table["surface"], ports.surface);
    for (const key of ["retrieval", "embedding", "llm"] as const) {
      const nested = table[key];
      if (isPlainObject(nested) && typeof table[key] !== "string") {
        ports.extra[key] = redactTable(nested);
      }
    }
  }

  if ("sensitivity" in root) {
    const table = root["sensitivity"];
    if (!isPlainObject(table)) {
      throw new VaultConfigError(`${path}: [sensitivity] must be a table`);
    }
    const def = table["default"];
    if (def !== "public" && def !== "personal" && def !== "private") {
      throw new VaultConfigError(`${path}: sensitivity.default is invalid`);
    }
    sensitivity.default = def;
  }

  return {
    path,
    present: true,
    ports,
    serve,
    model_ref,
    sensitivity,
  };
}

export function effectiveVaultConfig(config: VaultConfig): Record<string, unknown> {
  return {
    path: config.path,
    present: config.present,
    ports: {
      retrieval: config.ports.retrieval,
      embedding: config.ports.embedding,
      llm: config.ports.llm,
      notifier: config.ports.notifier,
      surface: config.ports.surface,
      extra: config.ports.extra,
    },
    serve: config.serve,
    model_ref: config.model_ref,
    sensitivity: config.sensitivity,
    llm_model: asString(config.model_ref ?? "", "") || null,
  };
}
