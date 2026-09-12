import { resolve } from "node:path";
import { exportVault } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { portableLocalAdapter } from "../connections";
import { withVault } from "../context";
import type { CliIo, Command, CommandHelpSchema } from "./index";

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

export const EXPORT_SCHEMA = {
  options: ["--out"],
  flags: [],
} as const satisfies CommandHelpSchema;

export const exportCommand: Command = {
  name: "export",
  usage: "export --out DIR",
  summary: "dump vault files and ledger tables into an empty directory",
  schema: EXPORT_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...EXPORT_SCHEMA.options],
      flags: [...EXPORT_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const out = parsed.options.get("--out");
    if (out === undefined) throw new UsageError(this.usage);
    const outDir = resolve(out);

    return withVault(io, async (ctx) => {
      const manifest = exportVault(ctx.db, ctx.vaultPath, outDir, { portableLocal: portableLocalAdapter() });
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
          `connection_state=${countFile(manifest.files, "connections/portable-local.v1.jsonl")}`,
        ].join(" "),
      );
      return 0;
    }, { retrieval: "none" });
  },
};
