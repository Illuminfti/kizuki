import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  bindLocalSourcePort,
  isPlainObject,
  loadConfiguredRetrieval,
  PortError,
  PortRegistry,
} from "@kizuki/core";
import type { EmbeddingPort, RetrievalPort } from "@kizuki/core";
import { registerGgufEmbedding } from "@kizuki/embed-gguf";
import {
  createEmbeddedRetrievalPort,
  EMBEDDED_RETRIEVAL_DESCRIPTOR,
  registerEmbeddedRetrieval,
} from "@kizuki/retrieval-pg";

const CONFIG_REL = join(".kizuki", "serve.toml");
const CONFIG_BYTES = 65_536;

export interface ConfiguredEmbedding {
  id: string;
  config: Record<string, unknown>;
}

function hostContext(
  vaultPath: string,
  kind: "retrieval" | "embedding",
  id: string,
  config: Record<string, unknown>,
) {
  return {
    vault_path: vaultPath,
    data_dir: join(vaultPath, ".kizuki", kind, id),
    config,
    secrets: async () => {
      throw new Error(`no ${kind} secret is configured`);
    },
    clock: () => new Date().toISOString(),
    logger: () => {},
  };
}

/** Shared selection for CLI rebuild; opening the engine is a host concern. */
export function loadConfiguredEmbedding(vaultPath: string): ConfiguredEmbedding {
  const path = join(vaultPath, CONFIG_REL);
  const fallback = { id: "kizuki.embedding.none", config: {} };
  if (!existsSync(path)) return fallback;
  let parsed: unknown;
  try {
    if (statSync(path).size > CONFIG_BYTES) throw new Error("oversized config");
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PortError("config_invalid", "embedding configuration is unreadable", false);
  }
  if (!isPlainObject(parsed)) throw new PortError("config_invalid", "embedding configuration is invalid", false);
  if (parsed["ports"] === undefined) return fallback;
  if (!isPlainObject(parsed["ports"])) throw new PortError("config_invalid", "ports must be a table", false);
  const value = parsed["ports"]["embedding"];
  if (value === undefined) return fallback;
  const table = isPlainObject(value) ? value : { id: value };
  const id = table["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new PortError("config_invalid", "embedding must select an id", false);
  }
  if (id !== "kizuki.embedding.none" && id !== "kizuki.embedding.gguf") {
    throw new PortError("config_invalid", `unknown embedding port ${id}`, false);
  }
  const { id: _id, ...config } = table;
  return { id, config };
}

export async function openConfiguredEmbedding(vaultPath: string): Promise<EmbeddingPort | undefined> {
  const configured = loadConfiguredEmbedding(vaultPath);
  if (configured.id === "kizuki.embedding.none") return undefined;
  const registry = new PortRegistry();
  registerGgufEmbedding(registry);
  const bound = await registry.bindFromConfig<EmbeddingPort>("embedding", { embedding: configured.id }, hostContext(
    vaultPath,
    "embedding",
    configured.id,
    configured.config,
  ));
  return bound.port;
}

export async function openConfiguredRetrieval(
  vaultPath: string,
  selected?: string,
  options: { embedding?: EmbeddingPort } = {},
): Promise<RetrievalPort | undefined> {
  const configured = loadConfiguredRetrieval(vaultPath);
  const id = selected ?? configured.id;
  if (id === "kizuki.retrieval.fts5") return undefined;
  const registry = new PortRegistry();
  const embedding = options.embedding;
  if (embedding !== undefined) {
    registry.registerPort(
      EMBEDDED_RETRIEVAL_DESCRIPTOR,
      (ctx) => createEmbeddedRetrievalPort(ctx, { embedding }),
    );
  } else {
    registerEmbeddedRetrieval(registry);
  }
  const bound = await registry.bindFromConfig<RetrievalPort>("retrieval", { retrieval: id }, hostContext(
    vaultPath,
    "retrieval",
    id,
    configured.config,
  ));
  // Only this host-created embedded implementation receives the local capability.
  return id === "kizuki.retrieval.embedded-pg" ? bindLocalSourcePort(bound.port, { store_id: `local:${id}` }) : bound.port;
}

/** The embedded factory is a writer. Inspection must not acquire it or repair its files. */
export function inspectConfiguredRetrieval(vaultPath: string): boolean {
  const selected = loadConfiguredRetrieval(vaultPath).id;
  if (selected === "kizuki.retrieval.fts5") return false;
  const registry = new PortRegistry();
  registerEmbeddedRetrieval(registry);
  registry.resolvePort("retrieval", selected);
  return true;
}
