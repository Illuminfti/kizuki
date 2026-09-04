import { runPurge, verifyPurge } from "@kizuki/core";
import type { PurgeFilter } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { resolveConnectorId } from "../connections";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import type { CliIo, Command } from "./index";

export const PURGE_IRREVERSIBLE =
  "Purge physically deletes event evidence. Undo cannot resurrect purged events. Canon rewrites stay reversible by receipt.";

function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

export const purgeCommand: Command = {
  name: "purge",
  usage:
    "purge (--event ID | --subject ID [--include-aliases] | --connector ID [--record ID] | --verify RECEIPT) [--reason TEXT] [--json]",
  summary:
    "physically delete matching events, hold affected pages, and prove absence",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [
        "--event",
        "--subject",
        "--connector",
        "--record",
        "--reason",
        "--verify",
      ],
      flags: ["--include-aliases", "--json"],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const asJson = parsed.flags.has("--json");

    const verifyId = parsed.options.get("--verify");
    if (verifyId !== undefined) {
      if (
        parsed.options.has("--event") ||
        parsed.options.has("--subject") ||
        parsed.options.has("--connector") ||
        parsed.options.has("--record") ||
        parsed.options.has("--reason") ||
        parsed.flags.has("--include-aliases")
      ) {
        throw new UsageError(this.usage);
      }
      return withVault(io, async (ctx) => {
        const report = await verifyPurge(ctx.db, ctx.vaultPath, verifyId);
        if (asJson) {
          io.out(
            jsonEnvelope(report.ok ? "purge" : "purge", report.ok ? "ok" : "error", {
              ...report,
              ops: report.proofs.map((proof) => ({
                store: proof.store,
                state: proof.found.length === 0 ? "done" : "failed",
                checked: proof.checked,
                found: proof.found,
              })),
            }),
          );
        } else {
          for (const proof of report.proofs) {
            const status = proof.found.length === 0 ? "done" : "failed";
            io.out(
              `${pad(proof.store, 23)} checked ${proof.checked}  found ${proof.found.length}   ${status}`,
            );
          }
          const hold = report.hold_lifted ? "hold lifted" : "hold remains";
          io.out(
            `${pad("canon", 23)} pages rewritten ${report.pages_rewritten}    ${hold}`,
          );
          if (!report.ok) {
            io.err(`retry: kizuki purge --verify ${verifyId}`);
          }
        }
        return report.ok ? 0 : 1;
      });
    }

    const reason = parsed.options.get("--reason");
    const eventId = parsed.options.get("--event");
    const subject = parsed.options.get("--subject");
    const connector = parsed.options.get("--connector");
    const record = parsed.options.get("--record");
    const includeAliases = parsed.flags.has("--include-aliases");
    const selectors = [eventId, subject, connector].filter(
      (value) => value !== undefined,
    );
    if (reason === undefined || selectors.length !== 1) {
      throw new UsageError(this.usage);
    }
    if (record !== undefined && connector === undefined) {
      throw new UsageError(this.usage);
    }
    if (includeAliases && subject === undefined) {
      throw new UsageError(this.usage);
    }

    let filter: PurgeFilter;
    if (eventId !== undefined) filter = { event_id: eventId };
    else if (subject !== undefined) filter = { subject_handle: subject };
    else {
      filter = { connector_id: resolveConnectorId(connector ?? "") };
      if (record !== undefined) filter.source_record_id = record;
    }

    return withVault(io, async (ctx) => {
      io.err(PURGE_IRREVERSIBLE);
      const outcome = await runPurge(ctx.db, ctx.vaultPath, filter, reason, {
        include_aliases: includeAliases,
      });
      if (asJson) {
        io.out(
          jsonEnvelope("purge", "ok", {
            ...outcome,
            irreversible_events: true,
            undo_restores_canon_only: true,
          }),
        );
      } else {
        io.out(
          `purged ${plural(outcome.receipts.length, "event")}; held ${plural(outcome.canon_holds.length, "page")}; ${plural(outcome.purge_ops.length, "store op")} pending`,
        );
        const receipt = outcome.receipts[0];
        if (receipt !== undefined) {
          io.out(`receipt ${receipt.receipt_id}`);
          if (includeAliases) io.out(receipt.reason);
        }
        io.out(PURGE_IRREVERSIBLE);
        for (const op of outcome.purge_ops) {
          io.out(`op ${op.store} state=${op.state}`);
        }
      }
      return 0;
    });
  },
};
