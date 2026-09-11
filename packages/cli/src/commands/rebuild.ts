import { rebuildRetrieval } from "@kizuki/core";
import { parseArguments, UsageError } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import { refreshDerived } from "../derived";
import { pruneOldOwnedRetrieval } from "../owned-retrieval-inventory";
import type { Command } from "./index";

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: "rebuild [--layer all|graph] [--prune-old] [--json]",
  summary: "rebuild configured retrieval and the lexical floor, or prune inactive retrieval stores",
  async run(io, args) {
    const parsed = parseArguments(args, { options: ["--layer"], flags: ["--json", "--prune-old"] });
    const layer = parsed.options.get("--layer") ?? "all";
    const pruneOld = parsed.flags.has("--prune-old");
    if (parsed.positionals.length > 0 || (layer !== "all" && layer !== "graph")) {
      throw new UsageError("rebuild supports --layer all or graph; other partial layers are not implemented");
    }
    if (pruneOld && parsed.options.has("--layer")) {
      throw new UsageError("rebuild --prune-old cannot be combined with --layer");
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
      const result = await rebuildRetrieval(ctx.db, ctx.vaultPath, ctx.retrieval, { layer });
      if (layer === "all") refreshDerived(ctx.db, ctx.vaultPath);
      io.out(parsed.flags.has("--json") ? jsonEnvelope("rebuild", "ok", result)
        : `rebuilt=${result.documents} backend=${result.backend} store=${result.store} floor_documents=${result.floor_documents} generation=${result.generation}`);
      return 0;
    });
  },
};
