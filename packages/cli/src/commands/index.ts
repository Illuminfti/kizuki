import { auditCommand } from "./audit";
import { backfillCommand } from "./backfill";
import { connectCommand } from "./connect";
import { doctorCommand } from "./doctor";
import { exportCommand } from "./export";
import { importCommand } from "./import";
import { initCommand } from "./init";
import { promoteCommand } from "./promote";
import { purgeCommand } from "./purge";
import { queryCommand } from "./query";
import { rejectCommand } from "./reject";
import { reviewCommand } from "./review";
import { syncCommand } from "./sync";
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
  auditCommand,
  undoCommand,
  reviewCommand,
  promoteCommand,
  rejectCommand,
  queryCommand,
  doctorCommand,
  purgeCommand,
  exportCommand,
  versionCommand,
];
