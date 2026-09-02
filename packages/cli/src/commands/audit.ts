import { listAuditReceipts } from "@kizuki/core";
import { runAudit } from "@kizuki/tui";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { jsonLine, table } from "../output";
import type { CliIo, Command } from "./index";

function shortHash(hash: string | null): string {
  if (hash === null) return "";
  return hash;
}

export const auditCommand: Command = {
  name: "audit",
  usage:
    "audit [--since TIME] [--page PATH] [--writer NAME] [--contested] [--ambiguous] [--reverted] [--json]",
  summary: "list receipted writes, or open the audit TUI",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--since", "--page", "--writer"],
      flags: ["--contested", "--ambiguous", "--reverted", "--json", "--list"],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    const interactive =
      io.stdinIsTTY &&
      io.stdoutIsTTY &&
      !parsed.flags.has("--json") &&
      !parsed.flags.has("--list");

    return withVault(io, async (ctx) => {
      if (interactive) {
        const summary = await runAudit({
          db: ctx.db,
          vaultPath: ctx.vaultPath,
        });
        io.out(`session undone=${summary.undone}`);
        return 0;
      }

      const since = parsed.options.get("--since");
      const page = parsed.options.get("--page");
      const writer = parsed.options.get("--writer");
      const rows = listAuditReceipts(ctx.db, {
        ...(since !== undefined ? { since } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(writer !== undefined ? { writer } : {}),
        ...(parsed.flags.has("--contested") ? { contested: true } : {}),
        ...(parsed.flags.has("--ambiguous") ? { ambiguous: true } : {}),
        ...(parsed.flags.has("--reverted") ? { reverted: true } : {}),
        limit: 5000,
      });

      if (parsed.flags.has("--json")) {
        for (const row of rows) io.out(jsonLine(row));
        return 0;
      }

      const lines = table([
        ["receipt", "writer", "action", "page", "before", "after", "reverted"],
        ...rows.map((row) => [
          row.receipt_id,
          row.writer,
          row.page_action,
          row.page_path,
          shortHash(row.before_hash),
          row.after_hash,
          row.reverted_by ?? "",
        ]),
      ]);
      for (const line of lines) io.out(line);
      return 0;
    });
  },
};
