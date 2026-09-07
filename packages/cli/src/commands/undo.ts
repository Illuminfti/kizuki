import { CanonRecoveryError, getCanonReceipt, inspectCanonRecovery, UndoError, undoReceipt } from "@kizuki/core";
import { UsageError, parseArguments, requirePositional } from "../args";
import { withVault } from "../context";
import { tryRefreshDerived } from "../derived";
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
      const original = getCanonReceipt(ctx.db, receiptId);
      try {
        const revert = await undoReceipt(
          { db: ctx.db, vault_path: ctx.vaultPath, ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }) },
          receiptId,
          { cascade: parsed.flags.has("--cascade") },
        );
        io.out(`receipt_id=${revert.receipt_id}`);
        io.out(`reverts=${revert.reverts ?? ""}`);
        io.out(`page_path=${revert.page_path}`);
        io.out(`before_hash=${revert.before_hash ?? ""}`);
        io.out(`after_hash=${revert.after_hash}`);
        if (revert.projection_pending === true) {
          io.err("The memory change is undone. Retrieval updates remain pending; run: kizuki recover --json");
          return 1;
        }
        const derived = tryRefreshDerived(ctx.db, ctx.vaultPath);
        for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
        return 0;
      } catch (error) {
        const pending = inspectCanonRecovery(ctx.db);
        if (error instanceof CanonRecoveryError || (pending.pending && pending.page_path === original?.page_path)) {
          io.err("Undo completion is unconfirmed because recovery remains pending. Run kizuki recover --json; inspect unknown external operations before another change.");
          return 1;
        }
        if (error instanceof UndoError) {
          io.err(error.message);
          return 1;
        }
        throw error;
      }
    });
  },
};
