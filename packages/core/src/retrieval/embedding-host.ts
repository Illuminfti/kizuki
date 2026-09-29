import { join } from "node:path";
import type { EmbeddingPort } from "../contracts/embedding";
import { PortError } from "../contracts/ports";
import type { PortLogLine } from "../contracts/ports";
import { PortRegistry } from "../contracts/registry";
import { loadEmbeddingSelection } from "../serve/config";

/**
 * Binds the embedding port the vault's `[ports] embedding` selects, or returns
 * undefined when it selects none. The host names the packages it links by
 * registering their factories; core knows no concrete embedder. Binding does
 * no I/O beyond the port's own construction, so a server that is down does not
 * stop a host from starting.
 */
export async function bindConfiguredEmbedding(
  vaultPath: string,
  register: (registry: PortRegistry) => void,
  logger: (line: PortLogLine) => void = () => {},
): Promise<EmbeddingPort | undefined> {
  const selection = loadEmbeddingSelection(vaultPath);
  if (selection.state === "invalid") {
    throw new PortError(
      "config_invalid",
      selection.id === undefined ? selection.message : `${selection.message} ${selection.id}`,
      false,
    );
  }
  if (selection.id === "kizuki.embedding.none") return undefined;
  const registry = new PortRegistry();
  register(registry);
  const bound = await registry.bindFromConfig<EmbeddingPort>(
    "embedding",
    { embedding: selection.id },
    {
      vault_path: vaultPath,
      data_dir: join(vaultPath, ".kizuki", "embedding", selection.id),
      config: selection.config,
      secrets: async () => {
        throw new Error("no embedding secret is configured");
      },
      clock: () => new Date().toISOString(),
      logger,
    },
  );
  return bound.port;
}
