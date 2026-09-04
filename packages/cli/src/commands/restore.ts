import { resolve } from "node:path";
import { restoreVault, verifyBackup } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import type { CliIo, Command } from "./index";

export const restoreCommand: Command = {
  name: "restore",
  usage: "restore --from DIR [--into DIR] [--verify]",
  summary: "verify a backup and restore it into an empty directory",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--from", "--into"],
      flags: ["--verify"],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const from = parsed.options.get("--from");
    if (from === undefined) throw new UsageError(this.usage);
    const backupDir = resolve(from);
    const into = parsed.options.get("--into");
    if (into === undefined) {
      const manifest = verifyBackup(backupDir);
      io.out(`verified=${backupDir}/manifest.json`);
      io.out(`schema=${manifest.schema} complete=${manifest.complete}`);
      return 0;
    }
    const report = restoreVault(backupDir, resolve(into));
    io.out(`vault=${resolve(into)}`);
    io.out(
      [
        `events=${report.events}`,
        `claims=${report.claims}`,
        `receipts=${report.receipts}`,
        `vault_files=${report.vault_files}`,
        `doctor_valid=${report.doctor.valid}`,
        `doctor_invalid=${report.doctor.invalid}`,
      ].join(" "),
    );
    return 0;
  },
};
