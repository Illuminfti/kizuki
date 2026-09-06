import { appCommand } from "./app";
import { agentCommand } from "./agent";
import { auditCommand } from "./audit";
import { backfillCommand } from "./backfill";
import { connectCommand } from "./connect";
import { contextCommand } from "./context";
import { doctorCommand } from "./doctor";
import { exportCommand } from "./export";
import { importCommand } from "./import";
import { rebuildCommand } from "./rebuild";
import { restoreCommand } from "./restore";
import { initCommand } from "./init";
import { modelsCommand } from "./models";
import { purgeCommand } from "./purge";
import { queryCommand } from "./query";
import { serveCommand } from "./serve";
import { syncCommand } from "./sync";
import { tellCommand } from "./tell";
import { undoCommand } from "./undo";
import { versionCommand } from "./version";

export interface CliIo {
  env: Record<string, string | undefined>;
  vaultOverride: string | null;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  out(line: string): void;
  err(line: string): void;
  prompt(question: string, opts?: { secret?: boolean }): Promise<string>;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  run(io: CliIo, args: string[]): Promise<number>;
}

export const COMMANDS: readonly Command[] = [
  appCommand,
  agentCommand,
  initCommand,
  connectCommand,
  backfillCommand,
  syncCommand,
  importCommand,
  modelsCommand,
  auditCommand,
  tellCommand,
  undoCommand,
  queryCommand,
  contextCommand,
  doctorCommand,
  serveCommand,
  purgeCommand,
  exportCommand,
  restoreCommand,
  rebuildCommand,
  versionCommand,
];
