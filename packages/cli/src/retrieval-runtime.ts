import { join } from "node:path";
import { loadConfiguredRetrieval, PortRegistry } from "@kizuki/core";
import type { RetrievalPort } from "@kizuki/core";
import { registerEmbeddedRetrieval } from "@kizuki/retrieval-pg";

export async function openConfiguredRetrieval(vaultPath: string, selected?: string): Promise<RetrievalPort | undefined> {
  const configured = loadConfiguredRetrieval(vaultPath);
  const id = selected ?? configured.id;
  if (id === "kizuki.retrieval.fts5") return undefined;
  const registry = new PortRegistry();
  registerEmbeddedRetrieval(registry);
  const bound = await registry.bindFromConfig<RetrievalPort>("retrieval", { retrieval: id }, {
    vault_path: vaultPath,
    data_dir: join(vaultPath, ".kizuki", "retrieval", id),
    config: configured.config,
    secrets: async () => { throw new Error("no retrieval secret is configured"); },
    clock: () => new Date().toISOString(),
    logger: () => {},
  });
  return bound.port;
}
