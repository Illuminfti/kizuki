import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SENSITIVITY_LEVELS, ownerPromote } from "@kizuki/core/staging";
import type { OwnerPromoteOptions, Sensitivity } from "@kizuki/core/staging";
import { UsageError, parseArguments, requirePositional } from "../args";
import { withVault } from "../context";
import { indexPagePath } from "../derived";
import type { CliIo, Command } from "./index";

export const promoteCommand: Command = {
  name: "promote",
  usage:
    "promote <proposal_id> [--sensitivity public|personal|private] [--body-file PATH]",
  summary: "owner-promote one pending proposal into canon",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--sensitivity", "--body-file"],
    });
    const [proposalId] = requirePositional(parsed.positionals, 1);
    if (proposalId === undefined) throw new UsageError(this.usage);

    const rawSensitivity = parsed.options.get("--sensitivity");
    if (
      rawSensitivity !== undefined &&
      !(SENSITIVITY_LEVELS as readonly string[]).includes(rawSensitivity)
    ) {
      throw new UsageError(this.usage);
    }
    const bodyFile = parsed.options.get("--body-file");

    return withVault(io, async (ctx) => {
      const options: OwnerPromoteOptions = {};
      if (rawSensitivity !== undefined) {
        options.sensitivity = rawSensitivity as Sensitivity;
      }
      if (bodyFile !== undefined) {
        options.editBody = readFileSync(bodyFile, "utf8");
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
