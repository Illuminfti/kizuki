import {
  rebuildRetrieval,
  persistConfiguredRetrieval,
  countRetrievalDocuments,
  readRetrievalEngineSpace,
  planFullReembed,
  formatReembedRefusal,
  inspectServeDoctor,
  loadConfiguredRetrieval,
  PortError,
  type EmbeddingPort,
  type RebuildBudget,
  type RetrievalPort,
} from "@kizuki/core";
import { parseArguments, UsageError } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import { refreshDerived } from "../derived";
import { pruneOldOwnedRetrieval } from "../owned-retrieval-inventory";
import { openConfiguredEmbedding, openConfiguredRetrieval } from "../retrieval-runtime";
import { loadVaultConfig } from "../vault-config";
import type { Command, CommandHelpSchema } from "./index";

export const REBUILD_SCHEMA = {
  options: ["--layer", "--port", "--max-records", "--max-entries", "--max-source-bytes"],
  flags: ["--json", "--prune-old", "--confirm"],
  defaults: { "--layer": "all" },
  bounds: { "--layer": "all|search|graph" },
} as const satisfies CommandHelpSchema;

const BUDGET_OPTIONS = {
  "--max-records": "max_records",
  "--max-entries": "max_filesystem_entries",
  "--max-source-bytes": "max_source_bytes",
} as const;

/** Each budget dimension is raisable by the flag its refusal names. */
function parseBudget(options: Map<string, string>): Partial<RebuildBudget> {
  const budget: Partial<Record<(typeof BUDGET_OPTIONS)[keyof typeof BUDGET_OPTIONS], number>> = {};
  for (const [flag, key] of Object.entries(BUDGET_OPTIONS)) {
    const raw = options.get(flag);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new UsageError(`${flag} expects a positive integer`);
    }
    budget[key] = value;
  }
  return budget;
}

function nextConfiguredEmbeddingSpace(vaultPath: string): string | null {
  const extra = loadVaultConfig(vaultPath).ports.extra["embedding"];
  const expected = extra?.["expected_space"];
  return typeof expected === "string" && expected.length > 0 ? expected : null;
}

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: "rebuild [--layer all|search|graph] [--port ID] [--prune-old] [--confirm] [--json]",
  summary: "rebuild configured retrieval and the lexical floor, or prune inactive retrieval stores",
  schema: REBUILD_SCHEMA,
  async run(io, args) {
    const parsed = parseArguments(args, {
      options: [...REBUILD_SCHEMA.options],
      flags: [...REBUILD_SCHEMA.flags],
    });
    const layer = parsed.options.get("--layer") ?? REBUILD_SCHEMA.defaults["--layer"];
    const pruneOld = parsed.flags.has("--prune-old");
    const portId = parsed.options.get("--port");
    const confirm = parsed.flags.has("--confirm");
    if (parsed.positionals.length > 0 || (layer !== "all" && layer !== "graph" && layer !== "search")) {
      throw new UsageError("rebuild supports --layer all, search, or graph; other partial layers are not implemented");
    }
    const budget = parseBudget(parsed.options);
    if (pruneOld && (parsed.options.has("--layer") || portId !== undefined || confirm ||
        Object.keys(budget).length > 0)) {
      throw new UsageError("rebuild --prune-old cannot be combined with --layer, --port, --confirm, or a budget option");
    }
    return withVault(io, async ctx => {
      if (pruneOld) {
        const result = await pruneOldOwnedRetrieval(ctx.vaultPath, ctx.retrieval);
        if (result.pending.length > 0) {
          throw new Error(`rebuild --prune-old left inactive stores pending: ${result.pending.join(",")}`);
        }
        io.out(parsed.flags.has("--json")
          ? jsonEnvelope("rebuild", "ok", { mode: "prune-old", ...result })
          : `pruned=${result.pruned.join(",") || "none"} kept=${result.kept ?? "sqlite-floor"}`);
        return 0;
      }
      let selected: RetrievalPort | undefined;
      let embedding: EmbeddingPort | undefined;
      try {
        if (layer === "search" || layer === "graph") {
          if (portId !== undefined) {
            throw new PortError(
              "config_invalid",
              "partial layer rebuild is not supported for a configured retrieval engine",
              false,
            );
          }
        } else if (layer === "all") {
          const storeId = portId ?? loadConfiguredRetrieval(ctx.vaultPath).id;
          const previousSpace = readRetrievalEngineSpace(ctx.vaultPath, storeId);
          const nextSpace = nextConfiguredEmbeddingSpace(ctx.vaultPath);
          // Pricing a re-embed is the only reason to size the projection, and
          // sizing it reads the whole corpus. Do not pay that for a plain rebuild.
          const documents = (): number => countRetrievalDocuments(ctx.db, ctx.vaultPath, budget);
          const throughputDocsPerS = inspectServeDoctor(ctx.db, ctx.vaultPath).stores.embedding_throughput_docs_per_s;
          if (nextSpace !== null && nextSpace !== previousSpace) {
            const plan = planFullReembed({ previousSpace, nextSpace, documents: documents(), throughputDocsPerS });
            if (plan !== null && !confirm) throw new UsageError(formatReembedRefusal(plan));
          }
          if (storeId !== "kizuki.retrieval.fts5") {
            embedding = await openConfiguredEmbedding(ctx.vaultPath);
            const liveSpace = embedding?.space().id ?? null;
            if (liveSpace !== null && liveSpace !== previousSpace) {
              const plan = planFullReembed({ previousSpace, nextSpace: liveSpace, documents: documents(), throughputDocsPerS });
              if (plan !== null && !confirm) throw new UsageError(formatReembedRefusal(plan));
            }
            if (previousSpace !== null && embedding === undefined) {
              throw new PortError(
                "unavailable",
                "rebuild requires the matching embedding port for the stored vector space",
                false,
              );
            }
          }
          selected = await openConfiguredRetrieval(
            ctx.vaultPath,
            portId,
            embedding === undefined ? {} : { embedding },
          );
        }
        const result = await rebuildRetrieval(ctx.db, ctx.vaultPath, selected, { layer, budget });
        if (layer === "all" || layer === "search") refreshDerived(ctx.db, ctx.vaultPath);
        if (portId !== undefined && layer === "all") {
          persistConfiguredRetrieval(ctx.db, ctx.vaultPath, result.store);
        }
        io.out(parsed.flags.has("--json") ? jsonEnvelope("rebuild", "ok", result)
          : `rebuilt=${result.documents} backend=${result.backend} store=${result.store} floor_documents=${result.floor_documents} generation=${result.generation}`);
        return 0;
      } finally {
        try { await selected?.close(); } finally { await embedding?.close(); }
      }
    }, pruneOld ? {} : { retrieval: "none" });
  },
};
