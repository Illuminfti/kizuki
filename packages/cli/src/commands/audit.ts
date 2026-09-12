import { listAuditReceipts, undoReceipt } from "@kizuki/core";
import { runAudit } from "@kizuki/tui";
import { UsageError, parseArguments } from "../args";
import { withReadVault, withVault } from "../context";
import { jsonEnvelope, table } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

/** Public page size; the internal limit+1 peek stays inside core's 10000-row bound. */
const MAX_LIMIT = 5000;

function shortHash(hash: string | null): string {
  if (hash === null) return "";
  return hash;
}

function parseBoundedInt(raw: string, flag: string, min: number, max: number): number {
  if (!/^[0-9]+$/.test(raw)) throw new UsageError(`invalid ${flag}`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`invalid ${flag}`);
  }
  return value;
}

export const AUDIT_SCHEMA = {
  options: ["--since", "--page", "--writer", "--limit", "--offset"],
  flags: ["--contested", "--ambiguous", "--reverted", "--json", "--list"],
  defaults: { "--limit": "5000", "--offset": "0" },
  bounds: { "--since": "TIME", "--limit": "1..5000", "--offset": "N" },
} as const satisfies CommandHelpSchema;

export const auditCommand: Command = {
  name: "audit",
  usage:
    "audit [--since TIME] [--page PATH] [--writer NAME] [--contested] [--ambiguous] [--reverted] [--limit 1..5000] [--offset N] [--list] [--json]",
  summary: "see what changed, inspect its sources, and undo a write",
  schema: AUDIT_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...AUDIT_SCHEMA.options],
      flags: [...AUDIT_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    const rawLimit = parsed.options.get("--limit");
    const rawOffset = parsed.options.get("--offset");
    const limit =
      rawLimit === undefined ? MAX_LIMIT : parseBoundedInt(rawLimit, "--limit", 1, MAX_LIMIT);
    const offset =
      rawOffset === undefined ? 0 : parseBoundedInt(rawOffset, "--offset", 0, Number.MAX_SAFE_INTEGER);

    const interactive =
      io.stdinIsTTY &&
      io.stdoutIsTTY &&
      !parsed.flags.has("--json") &&
      !parsed.flags.has("--list") &&
      !parsed.options.has("--limit") &&
      !parsed.options.has("--offset");

    return withReadVault(io, async (ctx) => {
      const since = parsed.options.get("--since");
      const page = parsed.options.get("--page");
      const writer = parsed.options.get("--writer");
      const filters = {
        ...(since !== undefined ? { since } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(writer !== undefined ? { writer } : {}),
        ...(parsed.flags.has("--contested") ? { contested: true } : {}),
        ...(parsed.flags.has("--ambiguous") ? { ambiguous: true } : {}),
        ...(parsed.flags.has("--reverted") ? { reverted: true } : {}),
      };
      if (interactive) {
        const summary = await runAudit({
          get db() { return ctx.db; },
          undo: receiptId => ctx.pauseForMutation(() => withVault({ ...io, vaultOverride: ctx.vaultPath }, async writer =>
            undoReceipt({ db: writer.db, vault_path: writer.vaultPath, ...(writer.retrieval === undefined ? {} : { retrieval: writer.retrieval }) }, receiptId))),
          vaultPath: ctx.vaultPath,
          filters,
        });
        io.out(`session undone=${summary.undone}`);
        return 0;
      }

      ctx.assertCurrent();
      const fetched = listAuditReceipts(ctx.db, {
        ...filters,
        limit: limit + 1,
        offset,
      });
      const truncated = fetched.length > limit;
      const rows = truncated ? fetched.slice(0, limit) : fetched;
      const nextOffset = truncated ? offset + rows.length : null;

      if (parsed.flags.has("--json")) {
        io.out(
          jsonEnvelope("audit", "ok", {
            receipts: rows,
            truncated,
            next_offset: nextOffset,
          }),
        );
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
      if (nextOffset !== null) io.out(`truncated  next_offset=${nextOffset}`);
      return 0;
    });
  },
};
