import { join } from "node:path";
import {
  bindConfiguredEmbedding,
  bindLocalSourcePort,
  loadConfiguredRetrieval,
  loadEmbeddingSelection,
  PortError,
  PortRegistry,
} from "@kizuki/core";
import type { EmbeddingPort, RetrievalPort } from "@kizuki/core";
import { registerGgufEmbedding } from "@kizuki/embed-gguf";
import { registerLocalHttpEmbedding } from "@kizuki/embed-local-http";
import {
  createEmbeddedRetrievalPort,
  EMBEDDED_RETRIEVAL_DESCRIPTOR,
  registerEmbeddedRetrieval,
} from "@kizuki/retrieval-pg";

export interface ConfiguredEmbedding {
  id: string;
  config: Record<string, unknown>;
}

function hostContext(
  vaultPath: string,
  kind: "retrieval",
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
  const selection = loadEmbeddingSelection(vaultPath);
  if (selection.state === "invalid") {
    throw new PortError("config_invalid", selection.id === undefined ? selection.message : `${selection.message} ${selection.id}`, false);
  }
  return { id: selection.id, config: selection.config };
}

/**
 * Whether the vault configures an embedding port: the one fact doctor, `serve
 * status` and the daemon's sweep share to decide if `embed-backfill` has work.
 * An unreadable selection counts as not configured; rebuild names the refusal.
 */
export function embeddingConfigured(vaultPath: string): boolean {
  try {
    return loadConfiguredEmbedding(vaultPath).id !== "kizuki.embedding.none";
  } catch {
    return false;
  }
}

/** Every embedding port this build links. */
export function registerEmbeddings(registry: PortRegistry): void {
  registerGgufEmbedding(registry);
  registerLocalHttpEmbedding(registry);
}

export function openConfiguredEmbedding(vaultPath: string): Promise<EmbeddingPort | undefined> {
  return bindConfiguredEmbedding(vaultPath, registerEmbeddings);
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
  // Every process that writes the engine must cut chunks the way the embedder
  // wants them, so the configured embedding port is bound with it unless the
  // caller brings its own.
  const embedding = options.embedding ?? (id === "kizuki.retrieval.embedded-pg" ? await openConfiguredEmbedding(vaultPath) : undefined);
  const owned = options.embedding === undefined;
  if (embedding !== undefined) {
    registry.registerPort(
      EMBEDDED_RETRIEVAL_DESCRIPTOR,
      (ctx) => createEmbeddedRetrievalPort(ctx, { embedding, own_embedding: owned }),
    );
  } else {
    registerEmbeddedRetrieval(registry);
  }
  try {
    const bound = await registry.bindFromConfig<RetrievalPort>("retrieval", { retrieval: id }, hostContext(
      vaultPath,
      "retrieval",
      id,
      configured.config,
    ));
    // Only this host-created embedded implementation receives the local capability.
    return id === "kizuki.retrieval.embedded-pg" ? bindLocalSourcePort(bound.port, { store_id: `local:${id}` }) : bound.port;
  } catch (error) {
    // A busy engine leaves the embedding port this call opened with nobody to close it.
    if (owned) await embedding?.close();
    throw error;
  }
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
