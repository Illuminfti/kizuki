import { CanonRecoveryError, inspectCanonRecoveryDetail, recoverCanonWrites, resumePendingPurges, retryCanonProjectionObligations } from "@kizuki/core";
import type { CanonStageRecoveryRecord } from "@kizuki/core";
import { resolveStaleCanonHold, type StaleCanonHoldResolution } from "@kizuki/core/internal";
import { parseArguments, UsageError } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import type { Command, CommandHelpSchema } from "./index";

export const RECOVER_SCHEMA = {
  options: [],
  flags: ["--json", "--resolve-stale-hold", "--abort-unapplied-hold", "--dry-run", "--apply"],
} as const satisfies CommandHelpSchema;

export const recoverCommand: Command = {
  name: "recover",
  usage: "recover [--resolve-stale-hold [--dry-run | --apply]] [--json]",
  summary: "resume interrupted memory writes, purges and their retrieval updates",
  schema: RECOVER_SCHEMA,
  async run(io, args) {
    const parsed = parseArguments(args, {
      options: [...RECOVER_SCHEMA.options],
      flags: [...RECOVER_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    const resolveHold =
      parsed.flags.has("--resolve-stale-hold") || parsed.flags.has("--abort-unapplied-hold");
    const explicitDryRun = parsed.flags.has("--dry-run");
    const apply = parsed.flags.has("--apply");
    if (!resolveHold && (explicitDryRun || apply)) throw new UsageError(this.usage);
    if (explicitDryRun && apply) throw new UsageError(this.usage);

    return withVault(io, async ctx => {
      const target = {
        db: ctx.db,
        vault_path: ctx.vaultPath,
        ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
      };

      if (resolveHold) {
        const dryRun = !apply;
        const resolution: StaleCanonHoldResolution = resolveStaleCanonHold(target, { dryRun });
        let projections: string[] = [];
        let purges: { receipt_id: string; ok: boolean; error?: string }[] = [];
        if (!dryRun && (resolution.status === "resolved" || resolution.status === "none")) {
          projections = (await retryCanonProjectionObligations(target)).completed;
          purges = await resumePendingPurges(
            ctx.db,
            ctx.vaultPath,
            ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval },
          );
        }
        const { stage_recoveries: pendingStageRecoveries, ...recovery } = inspectCanonRecoveryDetail(
          ctx.db,
          ctx.vaultPath,
        );
        const purgesPending = purges.filter(purge => !purge.ok).map(purge => purge.receipt_id);
        const ok = dryRun
          ? resolution.status === "resolvable" || resolution.status === "none"
          : (resolution.status === "resolved" || resolution.status === "none") &&
            !recovery.pending &&
            recovery.projection_pending === 0 &&
            purgesPending.length === 0;
        const result = {
          completed: [] as string[],
          projections_completed: projections,
          purges_resumed: purges.filter(purge => purge.ok).map(purge => purge.receipt_id),
          purges_pending: purgesPending,
          ...recovery,
          reason: resolution.refusal_reason ?? recovery.reason,
          stage_recoveries: recovery.pending ? pendingStageRecoveries : resolution.stage_recoveries,
          stale_hold_resolution: resolution,
        };
        if (parsed.flags.has("--json")) {
          io.out(jsonEnvelope("recover", ok ? "ok" : "error", result));
        } else if (resolution.status === "none") {
          io.out("No pending memory write hold to resolve.");
        } else if (resolution.status === "resolvable") {
          io.out(
            `Dry run: stale hold ${resolution.receipt_id} (${resolution.hold_reason}) on ${resolution.page_path} is unapplied on disk (before-image verified; ${resolution.claim_ids.length} claim(s) preserved for re-evaluation).`,
          );
          io.out("next: kizuki recover --resolve-stale-hold --apply");
        } else if (resolution.status === "resolved") {
          io.out(
            `Resolved stale hold ${resolution.receipt_id} (${resolution.hold_reason}) on ${resolution.page_path}: unapplied intent aborted, ${resolution.claim_ids.length} claim(s) retained for re-evaluation, audit record ${resolution.audit_record?.id ?? "-"}.`,
          );
        } else {
          io.err(
            `Refused stale hold resolution${resolution.receipt_id === null ? "" : ` for ${resolution.receipt_id}`}: ${resolution.refusal_reason ?? "unresolvable"}.`,
          );
        }
        return ok ? 0 : 1;
      }

      let completed: string[] = [], projections: string[] = [], reason: string | null = null;
      let purges: { receipt_id: string; ok: boolean; error?: string }[] = [];
      let stageRecoveries: CanonStageRecoveryRecord[] = [];
      try {
        const report = recoverCanonWrites(target);
        completed = report.completed; stageRecoveries = report.stage_recoveries;
        projections = (await retryCanonProjectionObligations(target)).completed;
        purges = await resumePendingPurges(ctx.db, ctx.vaultPath, ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval });
      } catch (error) {
        reason = error instanceof CanonRecoveryError ? error.reason : "completion_failed";
      }
      const { stage_recoveries: pendingStageRecoveries, ...recovery } = inspectCanonRecoveryDetail(ctx.db, ctx.vaultPath);
      const purgesPending = purges.filter(purge => !purge.ok).map(purge => purge.receipt_id);
      const ok = reason === null && !recovery.pending && recovery.projection_pending === 0 && purgesPending.length === 0;
      const result = { completed, projections_completed: projections, purges_resumed: purges.filter(purge => purge.ok).map(purge => purge.receipt_id),
        purges_pending: purgesPending, ...recovery, reason: reason ?? recovery.reason,
        stage_recoveries: recovery.pending ? pendingStageRecoveries : stageRecoveries };
      if (parsed.flags.has("--json")) io.out(jsonEnvelope("recover", ok ? "ok" : "error", result));
      else {
        io.out(`Memory writes recovered: ${completed.length}. Retrieval updates completed: ${projections.length}. Purges finished: ${result.purges_resumed.length}.`);
        for (const purge of purges.filter(item => !item.ok)) io.err(`Purge ${purge.receipt_id} is not finished${purge.error === undefined ? "" : ` (${purge.error})`}. next: kizuki purge --verify ${purge.receipt_id}`);
        for (const item of result.stage_recoveries) {
          io.out(`stage ${item.stage} ${item.classification}: ${item.action}${item.quarantine_path === null ? "" : ` to ${item.quarantine_path}`}${item.outcome === "done" ? "" : " (planned, not yet done)"}`);
        }
        if (!ok) {
          const next = recovery.next ?? "run: kizuki recover --json once the retrieval engine is available";
          io.err(`Recovery remains held${result.reason === null ? "" : `: ${result.reason}`}. next: ${next}`);
        }
      }
      return ok ? 0 : 1;
    }, { retrieval: "optional" });
  },
};
