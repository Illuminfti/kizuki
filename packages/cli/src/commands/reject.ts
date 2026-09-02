import { setProposalStatus } from "@kizuki/core/staging";
import { UsageError, parseArguments, requirePositional } from "../args";
import { withVault } from "../context";
import type { CliIo, Command } from "./index";

export const rejectCommand: Command = {
  name: "reject",
  usage: "reject <proposal_id> --reason TEXT",
  summary: "reject a pending proposal and remember the body hash",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: ["--reason"] });
    const [proposalId] = requirePositional(parsed.positionals, 1);
    const reason = parsed.options.get("--reason");
    if (proposalId === undefined || reason === undefined) {
      throw new UsageError(this.usage);
    }

    return withVault(io, async (ctx) => {
      setProposalStatus(ctx.db, proposalId, "rejected", reason);
      io.out(`proposal_id=${proposalId} status=rejected`);
      return 0;
    });
  },
};
