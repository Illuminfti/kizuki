import { agentCommand } from "./agent";
import { auditCommand } from "./audit";
import { backfillCommand } from "./backfill";
import { connectCommand } from "./connect";
import { contextCommand } from "./context";
import { doctorCommand } from "./doctor";
import { exportCommand } from "./export";
import { importCommand } from "./import";
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
  out(line: string): void;
  err(line: string): void;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  run(io: CliIo, args: string[]): Promise<number>;
}

export const COMMANDS: readonly Command[] = [
  initCommand,
  connectCommand,
  backfillCommand,
  syncCommand,
  importCommand,
  modelsCommand,
  agentCommand,
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
  versionCommand,
];
