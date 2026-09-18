import { join } from "node:path";
import {
  bindSourceModelPort, classifyAppModelCredential, readAppModelConfiguration, readAppModelFileCredential,
} from "@kizuki/core";
import type { SystemOnePort } from "@kizuki/core";
import { createSystemOneJevPort, parseSystemOneJevConfig, SYSTEMONE_JEV_ID } from "@kizuki/llm";
import { tokenResolver } from "./secrets";
import { loadSystemOneBinding } from "./vault-config";

export interface ReflexRuntime {
  readonly systemone: SystemOnePort | undefined;
  assertCurrent(): void;
  close(): Promise<void>;
}
/** Explicit owner invocation only. No daemon, capture, migration, or configuration writes. */
export async function openReflexRuntime(vaultPath: string, env: Record<string, string | undefined>): Promise<ReflexRuntime> {
  let base: SystemOnePort | undefined;
  try {
    const selected = loadSystemOneBinding(vaultPath);
    if (selected === null) return { systemone: undefined, assertCurrent() {}, async close() {} };
    if (selected.id !== SYSTEMONE_JEV_ID) throw new Error();
    const snapshot = JSON.stringify(selected);
    const configured = parseSystemOneJevConfig(selected.config);
    let secret: string | null = null;
    let credentialRevision: ReturnType<typeof readAppModelConfiguration>["revision"] | undefined;
    if (configured.secret_ref !== null) {
      if (classifyAppModelCredential(vaultPath, configured.secret_ref) === "env") {
        secret = await tokenResolver(configured.secret_ref, env)(configured.secret_ref);
      } else {
        const document = readAppModelConfiguration(vaultPath, () => {}, { reconcile: false });
        credentialRevision = document.revision;
        secret = readAppModelFileCredential(vaultPath, document.revision, configured.secret_ref, { reconcile: false });
      }
    }
    const assertCurrent = (): void => {
      if (JSON.stringify(loadSystemOneBinding(vaultPath)) !== snapshot ||
          (credentialRevision !== undefined && readAppModelConfiguration(vaultPath, () => {}, { reconcile: false }).revision !== credentialRevision)) {
        throw new Error("Reflex model configuration changed; retry");
      }
    };
    assertCurrent();
    base = createSystemOneJevPort({
      vault_path: vaultPath, data_dir: join(vaultPath, ".kizuki", "systemone", SYSTEMONE_JEV_ID),
      // One transport attempt per batch; queued batches recheck source consent.
      config: { ...selected.config, max_retries: 0 }, clock: () => new Date().toISOString(), logger: () => {},
      secrets: async ref => {
        if (ref !== configured.secret_ref || secret === null) throw new Error("Reflex credential unavailable");
        return secret;
      },
    });
    const transport = base;
    const systemone: SystemOnePort = {
      descriptor: transport.descriptor, model_ref: transport.model_ref,
      health: () => transport.health(), close: () => transport.close(),
      async evaluate(request) {
        assertCurrent(); const response = await transport.evaluate(request); assertCurrent(); return response;
      },
    };
    // parseSystemOneJevConfig removes trailing slashes; this is the adapter's exact route.
    bindSourceModelPort(systemone, { model_endpoint: `${configured.base_url}/systemone`, model: configured.model });
    return { systemone, assertCurrent, close: () => systemone.close() };
  } catch {
    await base?.close();
    throw new Error("Reflex model configuration unavailable; check ports.systemone and its credential binding");
  }
}
