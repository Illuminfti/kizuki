import type { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { hardenLedgerFile, isSnapshotBackup, restoreSnapshot, restoreVault, verifyBackup, verifySnapshot } from "@kizuki/core";
import { sealLedger } from "@kizuki/core/internal";
import { UsageError, parseArguments } from "../args";
import { portableLocalAdapter } from "../connections";
import { clean } from "../output";
import { refreshDerived } from "../derived";
import type { CliIo, Command, CommandHelpSchema } from "./index";

export const RESTORE_SCHEMA = {
  options: ["--from", "--into"],
  flags: ["--verify"],
} as const satisfies CommandHelpSchema;

export const restoreCommand: Command = {
  name: "restore",
  usage: "restore --from DIR [--into DIR] [--verify]",
  summary: "verify an export or snapshot and restore it into an empty directory",
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
    const snapshot = isSnapshotBackup(backupDir);
    if (into === undefined) {
      const manifest = snapshot ? verifySnapshot(backupDir) : verifyBackup(backupDir, { portableLocal: portableLocalAdapter() });
      io.out(`verified=${backupDir}/manifest.json`);
      io.out(`schema=${manifest.schema} complete=${manifest.complete}`);
      if (!snapshot && "schema_versions" in manifest && manifest.schema_versions.serve < 8) {
        io.out("warning=backup predates durable extraction recovery; an interrupted model decision was not preserved");
      }
      return 0;
    }
    const target = resolve(into);
    const options = { portableLocal: portableLocalAdapter(), rebuildDerived(db: Database, stagingPath: string) { refreshDerived(db, stagingPath); hardenLedgerFile(join(stagingPath, ".kizuki", "kizuki.db")); sealLedger(stagingPath, db); } };
    const restored = snapshot ? restoreSnapshot(backupDir, target, options) : undefined;
    const report = restored ?? restoreVault(backupDir, target, options);
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
    // No backup carries a credential, so each agent needs a fresh enrollment before it can act.
    if (restored !== undefined) {
      io.out(`reenroll_agents=${restored.agents.length}`);
      for (const name of restored.agents) io.out(`reenroll_agent=${clean(name)}`);
    } else {
      io.out("reenroll_agents=unknown");
      io.out("warning=export backups do not record agent names; enroll each agent again with kizuki agent add");
    }
    return 0;
  },
};
