import {
  PurgeError,
  previewPurge,
  resolvePurgeConnectorId,
  runPurge,
  verifyPurge,
} from "@kizuki/core";
import type { PurgeFilter, PurgePreview } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
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

function isExactSelector(filter: PurgeFilter): boolean {
  return filter.event_id !== undefined || filter.source_record_id !== undefined;
}

function describeSelector(filter: PurgeFilter): string {
  if (filter.event_id !== undefined) return `event_id=${filter.event_id}`;
  if (filter.subject_handle !== undefined) {
    return `subject_handle=${filter.subject_handle}`;
  }
  if (filter.connector_id !== undefined && filter.source_record_id !== undefined) {
    return `connector_id=${filter.connector_id} source_record_id=${filter.source_record_id}`;
  }
  if (filter.connector_id !== undefined) return `connector_id=${filter.connector_id}`;
  return "filter";
}

function printPreview(io: CliIo, preview: PurgePreview): void {
  io.out(
    `dry-run: ${plural(preview.event_count, "event")}; ${plural(preview.affected_pages.length, "page")}; retrieval ${preview.retrieval}`,
  );
  io.out(`selector ${describeSelector(preview.filter)}`);
  if (preview.connector_ids.length > 0) {
    io.out(`connectors ${preview.connector_ids.join(", ")}`);
  }
  if (preview.event_ids.length > 0) {
    io.out(`event_ids ${preview.event_ids.join(", ")}`);
  }
  if (preview.affected_pages.length > 0) {
    io.out(`pages ${preview.affected_pages.join(", ")}`);
  }
  if (preview.uncertain_pages.length > 0) {
    io.out(`uncertain ${preview.uncertain_pages.join(", ")}`);
  }
}

export const purgeCommand: Command = {
  name: "purge",
  usage:
    "purge (--event ID | --subject ID [--include-aliases] | --connector ID [--record ID] | --verify RECEIPT) [--reason TEXT] [--dry-run] [--confirm] [--allow-empty] [--json]",
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
      flags: ["--include-aliases", "--json", "--dry-run", "--confirm", "--allow-empty"],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const asJson = parsed.flags.has("--json");
    const dryRun = parsed.flags.has("--dry-run");
    const confirm = parsed.flags.has("--confirm");
    const allowEmpty = parsed.flags.has("--allow-empty");

    const verifyId = parsed.options.get("--verify");
    if (verifyId !== undefined) {
      if (
        parsed.options.has("--event") ||
        parsed.options.has("--subject") ||
        parsed.options.has("--connector") ||
        parsed.options.has("--record") ||
        parsed.options.has("--reason") ||
        parsed.flags.has("--include-aliases") ||
        dryRun ||
        confirm ||
        allowEmpty
      ) {
        throw new UsageError(this.usage);
      }
      return withVault(io, async (ctx) => {
        const report = await verifyPurge(ctx.db, ctx.vaultPath, verifyId);
        if (asJson) {
          io.out(
            jsonEnvelope("purge", report.ok ? "ok" : "error", {
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

    return withVault(io, async (ctx) => {
      let filter: PurgeFilter;
      if (eventId !== undefined) filter = { event_id: eventId };
      else if (subject !== undefined) filter = { subject_handle: subject };
      else {
        filter = {
          connector_id: resolvePurgeConnectorId(ctx.db, connector ?? ""),
        };
        if (record !== undefined) filter.source_record_id = record;
      }

      if (dryRun) {
        const preview = previewPurge(ctx.db, ctx.vaultPath, filter, reason, {
          include_aliases: includeAliases,
        });
        if (asJson) {
          io.out(
            jsonEnvelope(
              "purge",
              preview.event_count === 0 ? "error" : "ok",
              { ...preview, dry_run: true },
            ),
          );
        } else {
          printPreview(io, preview);
        }
        if (preview.event_count === 0 && !allowEmpty) {
          io.err(`purge matched no events for ${describeSelector(preview.filter)}`);
          return 1;
        }
        return 0;
      }

      if (!isExactSelector(filter) && !confirm) {
        throw new UsageError(
          "broad purge requires --confirm (or --dry-run)",
        );
      }

      io.err(PURGE_IRREVERSIBLE);
      try {
        const outcome = await runPurge(ctx.db, ctx.vaultPath, filter, reason, {
          include_aliases: includeAliases,
          allow_empty: allowEmpty,
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
      } catch (error) {
        if (error instanceof PurgeError && error.code === "no_match") {
          io.err(error.message);
          return 1;
        }
        throw error;
      }
    });
  },
};
