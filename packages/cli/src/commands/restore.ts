import { join, resolve } from "node:path";
import { hardenLedgerFile, restoreVault, verifyBackup } from "@kizuki/core";
import { sealLedger } from "@kizuki/core/internal";
import { UsageError, parseArguments } from "../args";
import { portableLocalAdapter } from "../connections";
import { refreshDerived } from "../derived";
import type { CliIo, Command, CommandHelpSchema } from "./index";

export const RESTORE_SCHEMA = {
  options: ["--from", "--into"],
  flags: ["--verify"],
} as const satisfies CommandHelpSchema;

export const restoreCommand: Command = {
  name: "restore",
  usage: "restore --from DIR [--into DIR] [--verify]",
  summary: "verify a backup and restore it into an empty directory",
  schema: RESTORE_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...RESTORE_SCHEMA.options],
      flags: [...RESTORE_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const from = parsed.options.get("--from");
    if (from === undefined) throw new UsageError(this.usage);
    const backupDir = resolve(from);
    const into = parsed.options.get("--into");
    if (into === undefined) {
      const manifest = verifyBackup(backupDir, { portableLocal: portableLocalAdapter() });
      io.out(`verified=${backupDir}/manifest.json`);
      io.out(`schema=${manifest.schema} complete=${manifest.complete}`);
      if (manifest.schema_versions.serve < 8) {
        io.out("warning=backup predates durable extraction recovery; an interrupted model decision was not preserved");
      }
      return 0;
    }
    const target = resolve(into);
    const report = restoreVault(backupDir, target, { portableLocal: portableLocalAdapter(), rebuildDerived(db, stagingPath) { refreshDerived(db, stagingPath); hardenLedgerFile(join(stagingPath, ".kizuki", "kizuki.db")); sealLedger(stagingPath, db); } });
    io.out(`vault=${target}`);
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
    for (const warning of report.recovery_warnings) io.out(`warning=${warning}`);
    io.out(`connection_state=${report.connection_state}`);
    return 0;
  },
};
