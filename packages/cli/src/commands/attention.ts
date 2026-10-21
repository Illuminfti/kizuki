import { OWNER, serveWorldView } from "@kizuki/core";
import { setAttentionDisposition } from "@kizuki/core/world";
import { parseArguments, UsageError } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import { attentionCli } from "./world/ops/attention";
import type { Command } from "./index";

export const attentionCommand: Command = {
  name: "attention", usage: "attention [--json] | attention dismiss CUE [--json] | attention snooze CUE --until TIME [--json]",
  summary: "read goal-aware cues or dismiss and snooze attention without changing facts",
  schema: { options: ["--until"], flags: ["--json"], bounds: { "--until": "RFC3339 time within the next year" } },
  async run(io, args) {
    const parsed = parseArguments(args, { options: ["--until"], flags: ["--json"] });
    const [action, cue] = parsed.positionals;
    if (parsed.positionals.length !== 0 && (parsed.positionals.length !== 2 || !["dismiss", "snooze"].includes(action!)) ||
        action !== "snooze" && parsed.options.has("--until") || action === "snooze" && !parsed.options.has("--until")) throw new UsageError(this.usage);
    return withVault(io, async ctx => {
      const owner = { db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER };
      if (action === undefined) {
        const envelope = serveWorldView(owner, { operation: "attention", ...attentionCli.buildInput(new Map()) });
        if (parsed.flags.has("--json")) io.out(jsonEnvelope("attention", "ok", envelope));
        else if ("result" in envelope.data && "data" in envelope.data.result && envelope.data.result.data.schema === "kizuki.attention/v1")
          for (const line of attentionCli.render(envelope.data.result.data)) io.out(line);
      } else {
        const result = setAttentionDisposition(owner, cue, action as "dismiss" | "snooze", parsed.options.get("--until"));
        io.out(parsed.flags.has("--json") ? jsonEnvelope("attention", "ok", result) : `${result.cue}: ${result.disposition}`);
      }
      return 0;
    }, { retrieval: "none" });
  },
};
