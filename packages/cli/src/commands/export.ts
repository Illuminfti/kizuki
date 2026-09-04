import { resolve } from "node:path";
import { exportVault } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import type { CliIo, Command } from "./index";

function countPrefix(
  files: Record<string, { count: number }>,
  prefix: string,
): number {
  return Object.keys(files).filter((key) => key.startsWith(prefix)).length;
}

function countFile(
  files: Record<string, { count: number }>,
  key: string,
): number {
  return files[key]?.count ?? 0;
}

export const exportCommand: Command = {
  name: "export",
  usage: "export --out DIR",
  summary: "dump vault files and ledger tables into an empty directory",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: ["--out"] });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const out = parsed.options.get("--out");
    if (out === undefined) throw new UsageError(this.usage);
    const outDir = resolve(out);

    return withVault(io, async (ctx) => {
      const manifest = exportVault(ctx.db, ctx.vaultPath, outDir);
      io.out(`manifest=${outDir}/manifest.json`);
      io.out(`schema=${manifest.schema} complete=${manifest.complete}`);
      io.out(
        [
          `vault_files=${countPrefix(manifest.files, "vault/")}`,
          `events=${countFile(manifest.files, "ledger/events.jsonl")}`,
          `purges=${countFile(manifest.files, "ledger/event_purges.jsonl")}`,
          `claims=${countFile(manifest.files, "claims/claims.jsonl")}`,
          `receipts=${countFile(manifest.files, "canon/receipts.jsonl")}`,
          `connections=${countFile(manifest.files, "connections.jsonl")}`,
          `checkpoints=${countFile(manifest.files, "checkpoints.jsonl")}`,
        ].join(" "),
      );
      return 0;
    });
  },
};
