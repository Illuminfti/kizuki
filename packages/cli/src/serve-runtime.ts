import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL_PRODUCER_ID,
  PortError,
  PortRegistry,
  SourceGrantError,
  bindSourceModelPort,
  isPlainObject,
  registerModelProducerPort,
  runToCompletion,
  readRetrievalDocuments,
  readAppModelConfiguration,
  classifyAppModelCredential,
  readAppModelFileCredential,
  type ClaimsIo,
  type LlmPort,
  type PortContext,
  type ProducerPort,
  type RailRuntime,
  type RailSyncResult,
  type RetrievalPort,
} from "@kizuki/core";
import { chatCompletionsUrl, parseOpenAiCompatibleConfig, registerLlmPorts } from "@kizuki/llm";
import { listHostConnections, loadConnector, closeHostConnector } from "./connections";
import { tryRefreshDerived } from "./derived";
import { tokenResolver } from "./secrets";

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

export type ServeRuntime = RailRuntime;

function runtimeError(message: string): never {
  throw new ServeRuntimeError(`serve model configuration: ${message}`);
}

function parseLlmSelection(llm: unknown): LlmSelection {
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
  secret: string | null,
  log: (line: string) => void,
): PortContext {
  const data_dir = join(vaultPath, ".kizuki", kind, id);
  mkdirSync(data_dir, { recursive: true, mode: 0o700 });
  return {
    vault_path: vaultPath,
    data_dir,
    config,
    secrets: async (requested) => {
      if (secret === null || requested !== secretRef) {
        runtimeError("secret reference is not bound to the selected model port");
      }
      return secret;
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
      const connector = await loadConnector(selected, store, db, env);
      try {
        const result = await runToCompletion(
          db,
          connector,
          selected.connection.connector_id,
          selected.connection.source_key,
          "sync",
          { vault_path: vaultPath },
        );
        events_stored += result.stored;
        events_duplicate += result.duplicates;
        events_synced += result.stored + result.duplicates;
        if (result.errors.length > 0 && errors.length < MAX_SYNC_ERRORS) {
          errors.push(`connector ${selected.connection.connector_id} sync failed`);
        }
      } finally { await closeHostConnector(connector); }
    } catch {
      if (errors.length < MAX_SYNC_ERRORS) {
        errors.push(`connector ${selected.connection.connector_id} sync unavailable`);
      }
    }
  }
  return { events_synced, events_stored, events_duplicate, events_self_skipped: 0, errors };
}

interface ServeRuntimeOptions {
  readonly db: Database;
  readonly vaultPath: string;
  readonly store: Parameters<typeof listHostConnections>[1];
  readonly env: Record<string, string | undefined>;
  readonly retrieval?: RetrievalPort;
  readonly err: (line: string) => void;
  /** Strict by default; the daemon can retain its useful local capture floor. */
  readonly configurationErrorMode?: "throw" | "disable-model";
}

async function bindModel(options: ServeRuntimeOptions): Promise<{ llm: LlmPort; producer?: ProducerPort }> {
  let document: ReturnType<typeof readAppModelConfiguration>;
  try {
    document = readAppModelConfiguration(options.vaultPath, value => { parseLlmSelection(value); });
  } catch { runtimeError("configuration snapshot unavailable"); }
  const selected = parseLlmSelection(document.llm);
  let secret: string | null = null;
  if (selected.secret_ref !== null) {
    try {
      secret = classifyAppModelCredential(options.vaultPath, selected.secret_ref) === "env"
        ? await tokenResolver(selected.secret_ref, options.env)(selected.secret_ref)
        : readAppModelFileCredential(options.vaultPath, document.revision, selected.secret_ref);
    } catch {
      runtimeError("configured secret reference cannot be resolved");
    }
  }
  const registry = new PortRegistry();
  registerLlmPorts(registry);
  const llm = (await registry.bindFromConfig<LlmPort>(
    "llm",
    { llm: selected.id },
    portContext(options.vaultPath, "llm", selected.id, selected.config, selected.secret_ref, secret, options.err),
  )).port;
  let producer: ProducerPort | undefined;
  try {
    if (llm.model_ref !== null) {
      registerModelProducerPort(() => llm, registry);
      producer = (await registry.bindFromConfig<ProducerPort>(
        "producer",
        { producer: MODEL_PRODUCER_ID },
        portContext(options.vaultPath, "producer", MODEL_PRODUCER_ID, {}, null, null, options.err),
      )).port;
      if (selected.id === MODEL_LLM_ID) {
        const configured = parseOpenAiCompatibleConfig(selected.config);
        bindSourceModelPort(producer, {
          model_endpoint: chatCompletionsUrl(configured.base_url),
          model: configured.model,
        });
      }
    }
  } catch (error) {
    // A partially bound producer is still owned here. Cleanup failures must
    // escape, rather than being mistaken for a safe model-disabled runtime.
    try {
      try { await producer?.close(); } finally { await llm.close(); }
    } catch { throw new Error("model runtime cleanup failed"); }
    throw error;
  }
  return { llm, ...(producer === undefined ? {} : { producer }) };
}

/** Bind one immutable model destination and credential for one rail attempt. */
export async function createServeRuntime(options: ServeRuntimeOptions): Promise<ServeRuntime> {
  let binding: Awaited<ReturnType<typeof bindModel>> | undefined;
  let configurationUnavailable = false;
  try { binding = await bindModel(options); }
  catch (error) {
    if (options.configurationErrorMode !== "disable-model" ||
        !(error instanceof ServeRuntimeError || error instanceof PortError || error instanceof SourceGrantError)) throw error;
    configurationUnavailable = true;
  }
  const claims: ClaimsIo = { db: options.db,
    ...(options.retrieval === undefined ? {} : { retrieval: options.retrieval }),
  };
  let closed = false;
  return {
    hooks: {
      model_ref: binding?.llm.model_ref ?? null,
      ...(binding?.producer === undefined ? {} : { producer: binding.producer }),
      claims,
      sync: async () => {
        const result = await syncConnections(options.db, options.vaultPath, options.store, options.env);
        return configurationUnavailable
          ? { ...result, errors: [...result.errors, "model configuration unavailable"] }
          : result;
      },
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
        if (binding?.producer !== undefined) await binding.producer.close();
      } finally {
        await binding?.llm.close();
      }
    },
  };
}
