import { UndoError, undoReceipt } from "@kizuki/core";
import { UsageError, parseArguments, requirePositional } from "../args";
import { withVault } from "../context";
import type { CliIo, Command } from "./index";

export const undoCommand: Command = {
  name: "undo",
  usage: "undo <receipt_id> [--cascade]",
  summary: "restore prior canon bytes from a write receipt",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { flags: ["--cascade"] });
    const [receiptId] = requirePositional(parsed.positionals, 1);
    if (receiptId === undefined) throw new UsageError(this.usage);

    return withVault(io, async (ctx) => {
      try {
        const revert = await undoReceipt(
          { db: ctx.db, vault_path: ctx.vaultPath },
          receiptId,
          { cascade: parsed.flags.has("--cascade") },
        );
        io.out(`receipt_id=${revert.receipt_id}`);
        io.out(`reverts=${revert.reverts ?? ""}`);
        io.out(`page_path=${revert.page_path}`);
        io.out(`before_hash=${revert.before_hash ?? ""}`);
        io.out(`after_hash=${revert.after_hash}`);
        return 0;
      } catch (error) {
        if (error instanceof UndoError) {
          io.err(error.message);
          return 1;
        }
        throw error;
      }
    });
  },
};
