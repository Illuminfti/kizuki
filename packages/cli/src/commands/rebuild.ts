import { rebuildRetrieval } from "@kizuki/core";
import { parseArguments, UsageError } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import type { Command } from "./index";

export const rebuildCommand: Command = {
  name: "rebuild",
  usage: "rebuild [--layer all] [--json]",
  summary: "rebuild configured retrieval and the lexical floor from authoritative evidence",
  async run(io, args) {
    const parsed = parseArguments(args, { options: ["--layer"], flags: ["--json"] });
    if (parsed.positionals.length > 0 || (parsed.options.get("--layer") ?? "all") !== "all") {
      throw new UsageError("rebuild supports --layer all only; partial layers are not implemented");
    }
    return withVault(io, async ctx => {
      const result = await rebuildRetrieval(ctx.db, ctx.vaultPath, ctx.retrieval);
      io.out(parsed.flags.has("--json") ? jsonEnvelope("rebuild", "ok", result)
        : `rebuilt=${result.documents} store=${result.store} generation=${result.generation}`);
      return 0;
    });
  },
};
