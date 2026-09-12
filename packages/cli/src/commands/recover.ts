import { CanonRecoveryError, inspectCanonRecovery, recoverCanonWrites, retryCanonProjectionObligations } from "@kizuki/core";
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
      try {
        completed = recoverCanonWrites(target).completed;
        projections = (await retryCanonProjectionObligations(target)).completed;
      } catch (error) {
        reason = error instanceof CanonRecoveryError ? error.reason : "completion_failed";
      }
      const recovery = inspectCanonRecovery(ctx.db);
      const ok = reason === null && !recovery.pending && recovery.projection_pending === 0;
      const result = { completed, projections_completed: projections, ...recovery, reason };
      if (parsed.flags.has("--json")) io.out(jsonEnvelope("recover", ok ? "ok" : "error", result));
      else {
        io.out(`Memory writes recovered: ${completed.length}. Retrieval updates completed: ${projections.length}.`);
        if (!ok) io.err(`Recovery remains pending${reason === null ? "" : `: ${reason}`}. Run kizuki doctor --json for the affected receipt. Existing holds remain in place.`);
      }
      return ok ? 0 : 1;
    }, { retrieval: "optional" });
  },
};
