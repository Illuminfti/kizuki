import { join } from "node:path";
import { SENSITIVITY_LEVELS, ownerPromote } from "@kizuki/core/staging";
import type { OwnerPromoteOptions, Sensitivity } from "@kizuki/core/staging";
import { UsageError, parseArguments, requirePositional } from "../args";
import { withVault } from "../context";
import { indexPagePath } from "../derived";
import type { CliIo, Command } from "./index";

/**
 * Leftover Wave 1 verb, not the product gate. It routes through the receipted
 * writer (`writer: "import"`); hand-edited prose is owner-authored evidence,
 * not promote input, so there is no body override here.
 */
export const promoteCommand: Command = {
  name: "promote",
  usage: "promote <proposal_id> [--sensitivity public|personal|private]",
  summary: "write one pending proposal into canon through the receipted writer",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: ["--sensitivity"] });
    const [proposalId] = requirePositional(parsed.positionals, 1);
    if (proposalId === undefined) throw new UsageError(this.usage);

    const rawSensitivity = parsed.options.get("--sensitivity");
    if (
      rawSensitivity !== undefined &&
      !(SENSITIVITY_LEVELS as readonly string[]).includes(rawSensitivity)
    ) {
      throw new UsageError(this.usage);
    }

    return withVault(io, async (ctx) => {
      const options: OwnerPromoteOptions = {};
      if (rawSensitivity !== undefined) {
        options.sensitivity = rawSensitivity as Sensitivity;
      }
      const receipt = ownerPromote(
        ctx.db,
        ctx.vaultPath,
        proposalId,
        options,
      );
      indexPagePath(ctx.db, ctx.vaultPath, receipt.page_path);
      io.out(`page_path=${join(ctx.vaultPath, receipt.page_path)}`);
      io.out(`receipt_id=${receipt.receipt_id}`);
      io.out(`kind=${receipt.kind}`);
      return 0;
    });
  },
};
