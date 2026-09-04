import { CorrectError, correct } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { tryRefreshDerived } from "../derived";
import { jsonEnvelope } from "../output";
import type { CliIo, Command } from "./index";

export const tellCommand: Command = {
  name: "tell",
  usage:
    'tell "<statement>" [--claim CLAIM_ID] [--since TIME] [--until TIME] [--dry-run] [--json] [--verbose]',
  summary: "correct a claim; rewrite affected canon in the same pass",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--about", "--claim", "--page", "--since", "--until"],
      flags: ["--dry-run", "--json", "--verbose"],
    });
    const statement = parsed.positionals[0];
    if (statement === undefined || parsed.positionals.length !== 1) {
      throw new UsageError(this.usage);
    }

    const about = parsed.options.get("--about");
    const claim = parsed.options.get("--claim");
    const page = parsed.options.get("--page");
    const since = parsed.options.get("--since");
    const until = parsed.options.get("--until");
    const target =
      about === undefined && claim === undefined && page === undefined
        ? undefined
        : {
            ...(claim === undefined ? {} : { claim_id: claim }),
            ...(page === undefined ? {} : { page_id: page }),
            ...(about === undefined ? {} : { subject: about }),
          };

    return withVault(io, async (ctx) => {
      try {
        const result = await correct(
          { db: ctx.db, vault_path: ctx.vaultPath },
          {
            statement,
            ...(target === undefined ? {} : { target }),
            ...(since === undefined && until === undefined
              ? {}
              : { scope: { ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) } }),
            ...(parsed.flags.has("--dry-run") ? { dry_run: true } : {}),
          },
        );
        const derived = tryRefreshDerived(ctx.db, ctx.vaultPath);
        if (parsed.flags.has("--json")) {
          io.out(
            jsonEnvelope(
              "tell",
              derived.degraded.length > 0 ? "degraded" : "ok",
              result,
              { degraded: derived.degraded },
            ),
          );
          return 0;
        }
        io.out(result.answer);
        if (parsed.flags.has("--verbose")) {
          for (const pageWrite of result.rewritten) {
            io.out(pageWrite.diff.trimEnd());
          }
        }
        for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
        return 0;
      } catch (error) {
        if (error instanceof CorrectError) {
          io.err(error.message);
          return 1;
        }
        throw error;
      }
    });
  },
};
