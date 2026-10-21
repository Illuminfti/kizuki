import { defineRail } from "./rail-definition";

/** Ledger initialization needs schedule metadata, never backup/restore or Git
 * capabilities. Load the implementation only when the scheduler runs this rail,
 * as with the built-in rails. The target is fixed and never comes from a record. */
export const BACKUP_RAIL = defineRail({
  id: "backup", period_s: 86_400, jitter_s: 0,
  summary: "When a backup directory is configured, exports, restores to verify, and retains the newest archives.",
  expects_output: false,
  retain_receipt: true,
  run: async context => (await import("./backup")).runScheduledBackup(context),
});
