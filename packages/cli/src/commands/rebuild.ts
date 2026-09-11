import { rebuildRetrieval } from "@kizuki/core";
import { parseArguments, UsageError } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import { refreshDerived } from "../derived";
import type { Command } from "./index";

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: "rebuild [--layer all|graph] [--json]",
  summary: "rebuild configured retrieval and the lexical floor from authoritative evidence",
  async run(io, args) {
    const parsed = parseArguments(args, { options: ["--layer"], flags: ["--json"] });
    const layer = parsed.options.get("--layer") ?? "all";
    if (parsed.positionals.length > 0 || (layer !== "all" && layer !== "graph")) {
      throw new UsageError("rebuild supports --layer all or graph; other partial layers are not implemented");
    }
    return withVault(io, async ctx => {
      const result = await rebuildRetrieval(ctx.db, ctx.vaultPath, ctx.retrieval, { layer });
      if (layer === "all") refreshDerived(ctx.db, ctx.vaultPath);
      io.out(parsed.flags.has("--json") ? jsonEnvelope("rebuild", "ok", result)
        : `rebuilt=${result.documents} backend=${result.backend} store=${result.store} floor_documents=${result.floor_documents} generation=${result.generation}`);
      return 0;
    });
  },
};
