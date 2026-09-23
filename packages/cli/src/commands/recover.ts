import { CanonRecoveryError, inspectCanonRecoveryDetail, recoverCanonWrites, retryCanonProjectionObligations } from "@kizuki/core";
import type { CanonStageRecoveryRecord } from "@kizuki/core";
import { parseArguments, UsageError } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import type { Command, CommandHelpSchema } from "./index";

export const RECOVER_SCHEMA = {
  options: [],
  flags: ["--json"],
} as const satisfies CommandHelpSchema;

export const recoverCommand: Command = {
  name: "recover",
  usage: "recover [--json]",
  summary: "resume interrupted memory writes and their retrieval updates",
  schema: RECOVER_SCHEMA,
  async run(io, args) {
    const parsed = parseArguments(args, {
      options: [...RECOVER_SCHEMA.options],
      flags: [...RECOVER_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    return withVault(io, async ctx => {
      const target = { db: ctx.db, vault_path: ctx.vaultPath,
        ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
      };
      let completed: string[] = [], projections: string[] = [], reason: string | null = null;
      let stageRecoveries: CanonStageRecoveryRecord[] = [];
      try {
        const report = recoverCanonWrites(target);
        completed = report.completed; stageRecoveries = report.stage_recoveries;
        projections = (await retryCanonProjectionObligations(target)).completed;
      } catch (error) {
        // The recovery boundary types every refusal it can explain.
        reason = error instanceof CanonRecoveryError ? error.reason : "completion_failed";
      }
      const { stage_recoveries: pendingStageRecoveries, ...recovery } = inspectCanonRecoveryDetail(ctx.db, ctx.vaultPath);
      const ok = reason === null && !recovery.pending && recovery.projection_pending === 0;
      const result = { completed, projections_completed: projections, ...recovery, reason: reason ?? recovery.reason,
        stage_recoveries: recovery.pending ? pendingStageRecoveries : stageRecoveries };
      if (parsed.flags.has("--json")) io.out(jsonEnvelope("recover", ok ? "ok" : "error", result));
      else {
        io.out(`Memory writes recovered: ${completed.length}. Retrieval updates completed: ${projections.length}.`);
        for (const item of result.stage_recoveries) io.out(`stage ${item.stage} ${item.classification}: ${item.action}${item.quarantine_path === null ? "" : ` to ${item.quarantine_path}`}`);
        if (!ok) {
          const next = recovery.next ?? "run: kizuki recover --json once the retrieval engine is available";
          io.err(`Recovery remains held${result.reason === null ? "" : `: ${result.reason}`}. next: ${next}`);
        }
      }
      return ok ? 0 : 1;
    }, { retrieval: "optional" });
  },
};
