import {
  rebuildRetrieval,
  persistConfiguredRetrieval,
  readRetrievalDocuments,
  readRetrievalEngineSpace,
  planFullReembed,
  formatReembedRefusal,
  inspectServeDoctor,
  loadConfiguredRetrieval,
  type RetrievalPort,
} from "@kizuki/core";
import { parseArguments, UsageError } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import { refreshDerived } from "../derived";
import { pruneOldOwnedRetrieval } from "../owned-retrieval-inventory";
import { openConfiguredRetrieval } from "../retrieval-runtime";
import { loadVaultConfig } from "../vault-config";
import type { Command, CommandHelpSchema } from "./index";

export const REBUILD_SCHEMA = {
  options: ["--layer", "--port"],
  flags: ["--json", "--prune-old", "--confirm"],
  defaults: { "--layer": "all" },
  bounds: { "--layer": "all|search|graph" },
} as const satisfies CommandHelpSchema;

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
    if (pruneOld && (parsed.options.has("--layer") || portId !== undefined || confirm)) {
      throw new UsageError("rebuild --prune-old cannot be combined with --layer, --port, or --confirm");
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
      try {
        if (layer === "all") {
          const storeId = portId ?? loadConfiguredRetrieval(ctx.vaultPath).id;
          const previousSpace = readRetrievalEngineSpace(ctx.vaultPath, storeId);
          const nextSpace = nextConfiguredEmbeddingSpace(ctx.vaultPath);
          if (nextSpace !== null && nextSpace !== previousSpace) {
            const plan = planFullReembed({
              previousSpace,
              nextSpace,
              documents: readRetrievalDocuments(ctx.db, ctx.vaultPath).length,
              throughputDocsPerS: inspectServeDoctor(ctx.db, ctx.vaultPath).stores.embedding_throughput_docs_per_s,
            });
            if (plan !== null && !confirm) throw new UsageError(formatReembedRefusal(plan));
          }
        }
        selected = portId === undefined
          ? ctx.retrieval
          : await openConfiguredRetrieval(ctx.vaultPath, portId);
        const result = await rebuildRetrieval(ctx.db, ctx.vaultPath, selected, { layer });
        if (layer === "all" || layer === "search") refreshDerived(ctx.db, ctx.vaultPath);
        if (portId !== undefined && layer === "all") {
          persistConfiguredRetrieval(ctx.db, ctx.vaultPath, result.store);
        }
        io.out(parsed.flags.has("--json") ? jsonEnvelope("rebuild", "ok", result)
          : `rebuilt=${result.documents} backend=${result.backend} store=${result.store} floor_documents=${result.floor_documents} generation=${result.generation}`);
        return 0;
      } finally {
        if (portId !== undefined) await selected?.close();
      }
    }, portId === undefined ? {} : { retrieval: "none" });
  },
};
