import { resolve } from "node:path";
import { backupVault } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import type { CliIo, Command, CommandHelpSchema } from "./index";

export const BACKUP_SCHEMA = {
  options: ["--out", "--wait"],
  flags: [],
} as const satisfies CommandHelpSchema;

const MAX_WAIT_SECONDS = 3_600;

export const backupCommand: Command = {
  name: "backup",
  usage: "backup --out DIR [--wait SECONDS]",
  summary: "snapshot a live vault into an empty directory that only restore reads",
  schema: BACKUP_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: [...BACKUP_SCHEMA.options], flags: [...BACKUP_SCHEMA.flags] });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const out = parsed.options.get("--out");
    if (out === undefined) throw new UsageError(this.usage);
    const wait = parsed.options.get("--wait");
    if (wait !== undefined && (!/^\d{1,4}$/.test(wait) || Number(wait) > MAX_WAIT_SECONDS)) throw new UsageError(this.usage);
    const outDir = resolve(out);
    return withVault(io, async (ctx) => {
      const manifest = await backupVault(ctx.db, ctx.vaultPath, outDir, wait === undefined ? {} : { wait_ms: Number(wait) * 1_000 });
      io.out(`manifest=${outDir}/manifest.json`);
      io.out(`schema=${manifest.schema} complete=${manifest.complete}`);
      io.out(`events=${manifest.events} receipts=${manifest.receipts} vault_files=${Object.keys(manifest.files).filter(path => path.startsWith("vault/")).length} agents=${manifest.agents.length}`);
      io.out("credentials, agent enrollments and connector state are not in a snapshot; restore it with kizuki restore");
      return 0;
    }, { retrieval: "none" });
  },
};
