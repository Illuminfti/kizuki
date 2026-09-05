import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL_PRODUCER_ID,
  PortRegistry,
  isPlainObject,
  registerModelProducerPort,
  runToCompletion,
  readRetrievalDocuments,
  type ClaimsIo,
  type LlmPort,
  type PortContext,
  type ProducerPort,
  type RailHooks,
  type RailSyncResult,
  type RetrievalPort,
} from "@kizuki/core";
import { registerLlmPorts } from "@kizuki/llm";
import { listHostConnections, loadConnector, closeHostConnector } from "./connections";
import { tryRefreshDerived } from "./derived";
import { tokenResolver } from "./secrets";

const CONFIG_PATH = ".kizuki/serve.toml";
const NONE_LLM_ID = "kizuki.llm.none";
const MODEL_LLM_ID = "kizuki.llm.openai-compatible";
const MAX_SYNC_ERRORS = 32;

export class ServeRuntimeError extends Error {
  override readonly name = "ServeRuntimeError";
}

interface LlmSelection {
  readonly id: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secret_ref: string | null;
}

export interface ServeRuntime {
  readonly hooks: RailHooks;
  close(): Promise<void>;
}

function runtimeError(message: string): never {
  throw new ServeRuntimeError(`serve model configuration: ${message}`);
}

function readLlmSelection(vaultPath: string): LlmSelection {
  const path = join(vaultPath, CONFIG_PATH);
  if (!existsSync(path)) return { id: NONE_LLM_ID, config: {}, secret_ref: null };
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    runtimeError("invalid TOML");
  }
  if (!isPlainObject(parsed)) runtimeError("config must be a table");
  const ports = parsed["ports"];
  if (ports === undefined) return { id: NONE_LLM_ID, config: {}, secret_ref: null };
  if (!isPlainObject(ports)) runtimeError("[ports] must be a table");
  const llm = ports["llm"];
  if (llm === undefined || llm === NONE_LLM_ID) {
    return { id: NONE_LLM_ID, config: {}, secret_ref: null };
  }
  if (typeof llm === "string") {
    runtimeError("ports.llm must be kizuki.llm.none or a configured [ports.llm] table");
  }
  if (!isPlainObject(llm)) runtimeError("[ports.llm] must be a table");
  const id = llm["id"];
  if (id === NONE_LLM_ID) return { id: NONE_LLM_ID, config: {}, secret_ref: null };
  if (id !== MODEL_LLM_ID) runtimeError("[ports.llm].id must select kizuki.llm.openai-compatible or kizuki.llm.none");
  const config: Record<string, unknown> = { ...llm };
  delete config["id"];
  const secret = config["secret_ref"];
  return {
    id,
    config,
    secret_ref: typeof secret === "string" ? secret : null,
  };
}

function portContext(
  vaultPath: string,
  kind: "llm" | "producer",
  id: string,
  config: Readonly<Record<string, unknown>>,
  secretRef: string | null,
  env: Record<string, string | undefined>,
  log: (line: string) => void,
): PortContext {
  const data_dir = join(vaultPath, ".kizuki", kind, id);
  mkdirSync(data_dir, { recursive: true, mode: 0o700 });
  const resolve = secretRef === null ? null : tokenResolver(secretRef, env);
  return {
    vault_path: vaultPath,
    data_dir,
    config,
    secrets: async (requested) => {
      if (resolve === null || requested !== secretRef) {
        runtimeError("secret reference is not bound to the selected model port");
      }
      return resolve(requested);
    },
    clock: () => new Date().toISOString(),
    logger: (line) => log(`model ${line.level}: ${line.message}`),
  };
}

async function syncConnections(
  db: Database,
  vaultPath: string,
  store: Parameters<typeof listHostConnections>[1],
  env: Record<string, string | undefined>,
): Promise<RailSyncResult> {
  let events_synced = 0;
  let events_stored = 0;
  let events_duplicate = 0;
  const errors: string[] = [];
  for (const selected of listHostConnections(db, store)) {
    if (selected.state === null) {
      if (errors.length < MAX_SYNC_ERRORS) errors.push("connection state unavailable");
      continue;
    }
    try {
<<<<<<< HEAD
      const connector = await loadConnector(selected, store, db, env);
      const result = await runToCompletion(
        db,
        connector,
        selected.connection.connector_id,
        selected.connection.source_key,
        "sync",
      );
      events_stored += result.stored;
      events_duplicate += result.duplicates;
      events_synced += result.stored + result.duplicates;
      if (result.errors.length > 0 && errors.length < MAX_SYNC_ERRORS) {
        errors.push(`connector ${selected.connection.connector_id} sync failed`);
      }
=======
      const connector = await loadConnector(selected, store, env, undefined, db);
      try {
        const result = await runToCompletion(
          db,
          connector,
          selected.connection.connector_id,
          selected.connection.source_key,
          "sync",
        );
        events_stored += result.stored;
        events_duplicate += result.duplicates;
        events_synced += result.stored + result.duplicates;
        if (result.errors.length > 0 && errors.length < MAX_SYNC_ERRORS) {
          errors.push(`connector ${selected.connection.connector_id} sync failed`);
        }
      } finally { await closeHostConnector(connector); }
>>>>>>> 7c9422e (Wire native Telegram enrollment with durable authenticated cooldowns)
    } catch {
      if (errors.length < MAX_SYNC_ERRORS) {
        errors.push(`connector ${selected.connection.connector_id} sync unavailable`);
      }
    }
  }
  return { events_synced, events_stored, events_duplicate, events_self_skipped: 0, errors };
}

/** Bind the complete model port before any rail is allowed to write canon. */
export async function createServeRuntime(options: {
  readonly db: Database;
  readonly vaultPath: string;
  readonly store: Parameters<typeof listHostConnections>[1];
  readonly env: Record<string, string | undefined>;
  readonly retrieval?: RetrievalPort;
  readonly err: (line: string) => void;
}): Promise<ServeRuntime> {
  const selected = readLlmSelection(options.vaultPath);
  if (selected.secret_ref !== null) {
    try {
      await tokenResolver(selected.secret_ref, options.env)(selected.secret_ref);
    } catch {
      runtimeError("configured secret reference cannot be resolved");
    }
  }
  const registry = new PortRegistry();
  registerLlmPorts(registry);
  const llm = (await registry.bindFromConfig<LlmPort>(
    "llm",
    { llm: selected.id },
    portContext(options.vaultPath, "llm", selected.id, selected.config, selected.secret_ref, options.env, options.err),
  )).port;
  let producer: ProducerPort | undefined;
  try {
    if (llm.model_ref !== null) {
      registerModelProducerPort(() => llm, registry);
      producer = (await registry.bindFromConfig<ProducerPort>(
        "producer",
        { producer: MODEL_PRODUCER_ID },
        portContext(options.vaultPath, "producer", MODEL_PRODUCER_ID, {}, null, options.env, options.err),
      )).port;
    }
  } catch (error) {
    await llm.close();
    throw error;
  }
  const claims: ClaimsIo = { db: options.db,
    ...(options.retrieval === undefined ? {} : { retrieval: options.retrieval }),
  };
  let closed = false;
  return {
    hooks: {
      model_ref: llm.model_ref,
      ...(producer === undefined ? {} : { producer }),
      claims,
      sync: () => syncConnections(options.db, options.vaultPath, options.store, options.env),
      refresh: async () => {
        const degraded: string[] = [];
        if (options.retrieval !== undefined) {
          try {
            if (options.retrieval.rebuildFromDocuments === undefined) throw new Error("rebuild unavailable");
            // Reuse the public bounded, authority-preserving projection. The engine
            // stages it before replacement, including edits, deletions and page writes.
            await options.retrieval.rebuildFromDocuments(readRetrievalDocuments(options.db, options.vaultPath));
          } catch { degraded.push("retrieval refresh unavailable"); }
        }
        const result = tryRefreshDerived(options.db, options.vaultPath);
        if (result.degraded.length > 0) degraded.push("derived index refresh degraded");
        return degraded;
      },
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        if (producer !== undefined) await producer.close();
      } finally {
        await llm.close();
      }
    },
  };
}
